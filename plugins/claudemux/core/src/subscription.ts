/**
 * The resident idle subscription.
 *
 * The orchestration core is a resident process, so it can hold a live
 * subscription to each teammate's turn signal rather than polling for it
 * (see `.agents/domains/mcp-native-orchestrator.md` §4). For a Claude
 * teammate that signal source is the per-sid marker files the Bash hooks
 * maintain under `/tmp/claude-idle/` — the `<sid>.busy` marker while a turn
 * runs, the bare `<sid>` marker once it ends.
 *
 * This module is that subscription: one `fs.watch` on the idle directory,
 * kept in a small in-memory map so a teammate's busy/idle state is a lookup,
 * not a stat. Phase A's reader is the `teammates` MCP tool, which annotates
 * each registry entry with its live signal. Phase B attaches the native
 * `wait` verb to the same watch.
 */

import { type FSWatcher, existsSync, mkdirSync, readdirSync, watch } from 'node:fs'

import { busyMarkerFor, idleDir, idleMarkerFor } from './paths'

/** A teammate's live turn signal, derived from its marker files. */
export interface Signal {
  /** The `<sid>.busy` marker is present — the session is mid-turn. */
  busy: boolean
  /** The bare `<sid>` marker is present — the session has reached an idle event. */
  idle: boolean
}

/**
 * A source of per-sid signal. The core depends on this narrow interface, not
 * on the concrete subscription, so a test can supply a fake without an
 * `fs.watch`.
 */
export interface SignalSource {
  /** The live signal for a session_id, or `undefined` if never observed. */
  signalFor(sid: string): Signal | undefined
}

/** A resident `fs.watch` over `/tmp/claude-idle/`, exposing per-sid signal. */
export class IdleSubscription implements SignalSource {
  #watcher: FSWatcher | null = null
  #signals = new Map<string, Signal>()

  /**
   * Begin watching. Creates the idle directory if absent (so the watch never
   * fails on a fresh machine), seeds the map with the current marker state,
   * then keeps it fresh on every change. Idempotent.
   */
  start(): void {
    if (this.#watcher) return
    mkdirSync(idleDir(), { recursive: true })
    this.#scanAll()
    const watcher = watch(idleDir(), (_event, filename) => {
      if (!filename) {
        // Some platforms omit the filename; fall back to a full rescan.
        this.#scanAll()
        return
      }
      // A non-sid filename (a core diagnostic log) maps to `''` — skip it, the
      // same guard `#scanAll` applies.
      const sid = sidOf(filename)
      if (sid) this.#refresh(sid)
    })
    // The watched directory can be removed under a resident core; without an
    // error handler that surfaces as an uncaught exception that kills the
    // core. Drop the dead watcher instead — the signal map goes stale, but the
    // process survives.
    watcher.on('error', (err) => {
      console.error(`[claudemux-core] idle subscription watch error: ${String(err)}`)
      watcher.close()
      if (this.#watcher === watcher) this.#watcher = null
    })
    this.#watcher = watcher
  }

  /** Stop watching and release the in-memory state. Idempotent. */
  stop(): void {
    this.#watcher?.close()
    this.#watcher = null
    this.#signals.clear()
  }

  /**
   * The live signal for a session_id, or `undefined` when the core has never
   * observed any marker for it.
   */
  signalFor(sid: string): Signal | undefined {
    return this.#signals.get(sid)
  }

  /** Re-derive the signal for one sid from its marker files. */
  #refresh(sid: string): void {
    this.#signals.set(sid, {
      busy: existsSync(busyMarkerFor(sid)),
      idle: existsSync(idleMarkerFor(sid)),
    })
  }

  /** Re-derive signals for every sid currently present in the idle directory. */
  #scanAll(): void {
    this.#signals.clear()
    let names: string[]
    try {
      names = readdirSync(idleDir())
    } catch {
      return
    }
    for (const sid of new Set(names.map(sidOf))) {
      if (sid) this.#refresh(sid)
    }
  }
}

/**
 * Map an idle-directory filename to the session_id it belongs to. The three
 * marker files for one session are `<sid>`, `<sid>.busy`, and `<sid>.last`;
 * the core's own diagnostic logs there start with `_` and map to `''`.
 *
 * Exported for unit testing — this is the one piece of parsing in the module.
 */
export function sidOf(filename: string): string {
  if (filename.startsWith('_')) return ''
  if (filename.endsWith('.busy')) return filename.slice(0, -'.busy'.length)
  if (filename.endsWith('.last')) return filename.slice(0, -'.last'.length)
  return filename
}
