/**
 * `ClaudeTeammateRecord` and the Claude engine's file-path builders.
 *
 * Decision 0024 §"TeammateRecord" pins the Claude engine's extension
 * surface to four flat files under `/tmp/teammate-<name>.<ext>`:
 *
 *  - `.cwd` — the teammate's physical cwd; written by `tm spawn`,
 *    consumed by `on-session-start.sh`'s sed-only fast path.
 *  - `.sid` — current Claude session id; written by `tm spawn`,
 *    rewritten by `on-session-start.sh` whenever `/clear` rotates the
 *    id. Read by every verb that needs to address the live transcript.
 *  - `.ready` — touched by `on-session-start.sh` once the REPL is up;
 *    cleared by `tm spawn` before launching `claude` so the readiness
 *    poll has a `before` reference.
 *  - `.send-at` — touched per `tm send`, consumed by the pane-quiet
 *    fallback timing on `tm wait`.
 *
 * The base `/tmp/teammate-<name>.json` is owned by
 * `persistence/identity-store.ts`; this file owns the engine-private
 * extension paths and the tmux session-name encoding for nested names.
 *
 * Path-builder discipline (decision 0004): every Claude-engine path
 * comes from a named function here, never a literal at a use site.
 *
 * Nested teammate names (decision 0024 §"Nested teammate names"):
 * `tm spawn flow/flow-1` is valid. tmux session names cannot contain
 * `/`, so this file encodes `/` → `__` via `tmuxSessionName`. The
 * inverse holds because `identity/name.ts` rejects raw names that
 * already contain `__`.
 *
 * Path-on-disk strategy: file paths under `/tmp/teammate-<name>.<ext>`
 * use the raw name verbatim — a nested name `flow/flow-1` produces
 * `/tmp/teammate-flow/flow-1.cwd`. All writers `mkdir -p` the parent
 * before writing (via `atomic-file.ts`), and the on-session-start hook
 * only touches files whose parent `tm spawn` has already created. The
 * tmux session name uses the encoded form because tmux itself forbids
 * `/` in session names.
 */

import { join } from 'node:path'

import { TeammateRecord } from '../teammate-record'
import type { EngineKind, TeammateName } from '../types'

/** The root directory the Claude engine's extension files live in. */
const TEAMMATE_ROOT = '/tmp'

/** `/tmp/teammate-<name>.cwd` — written at spawn; read by SessionStart hook. */
export function cwdFile(name: TeammateName): string {
  return join(TEAMMATE_ROOT, `teammate-${name}.cwd`)
}

/** `/tmp/teammate-<name>.sid` — current session id; updated by SessionStart on `/clear`. */
export function sidFile(name: TeammateName): string {
  return join(TEAMMATE_ROOT, `teammate-${name}.sid`)
}

/** `/tmp/teammate-<name>.ready` — touched by SessionStart; cleared before spawn. */
export function readyFile(name: TeammateName): string {
  return join(TEAMMATE_ROOT, `teammate-${name}.ready`)
}

/** `/tmp/teammate-<name>.send-at` — touched per send; read by the pane-quiet wait fallback. */
export function sendAtFile(name: TeammateName): string {
  return join(TEAMMATE_ROOT, `teammate-${name}.send-at`)
}

/** Root of the per-sid idle/busy/last markers the on-busy / on-stop hooks maintain. */
export function idleDir(): string {
  return '/tmp/claude-idle'
}

/** The bare `<sid>` marker — touched by `on-stop.sh` when a turn ends. */
export function idleMarkerFor(sid: string): string {
  return join(idleDir(), sid)
}

/** The `<sid>.busy` marker — present while a session is mid-turn. */
export function busyMarkerFor(sid: string): string {
  return join(idleDir(), `${sid}.busy`)
}

/** The `<sid>.last` file — text of the session's last assistant turn. */
export function lastFileFor(sid: string): string {
  return join(idleDir(), `${sid}.last`)
}

/** The session-name prefix every tmux teammate session carries. */
export const TMUX_SESSION_PREFIX = 'teammate-'

/**
 * Encode a (possibly nested) teammate name into a tmux session name.
 * Decision 0024 §"Nested teammate names" — the only place `/` becomes
 * `__`. `identity/name.ts`'s validator rejects raw names that already
 * contain `__`, so the encoding is round-trippable.
 *
 * Example: `flow/flow-1` → `teammate-flow__flow-1`.
 */
export function tmuxSessionName(name: TeammateName): string {
  return `${TMUX_SESSION_PREFIX}${name.replace(/\//g, '__')}`
}

/**
 * Approximate inverse of `tmuxSessionName`. Lossy by construction: a raw
 * teammate name `flow__1` and a nested name `flow/1` both encode to
 * `teammate-flow__1`, so the reverse path cannot recover the original
 * once a `__` appears. Production listing code reads names from the
 * base TeammateRecord JSON instead; this helper is a convenience for
 * tests and diagnostics that already know no nested decoding is needed.
 */
export function decodeTmuxSessionName(session: string): TeammateName | null {
  if (!session.startsWith(TMUX_SESSION_PREFIX)) return null
  return session.slice(TMUX_SESSION_PREFIX.length).replace(/__/g, '/')
}

/** Per-teammate file fan-out for the Claude engine. */
export interface ClaudeTeammateExtension {
  readonly cwd: string
  readonly sid: string
  readonly ready: string
  readonly sendAt: string
}

/** Materialise the Claude engine's extension paths for one teammate name. */
export function claudeExtensionFor(name: TeammateName): ClaudeTeammateExtension {
  return {
    cwd: cwdFile(name),
    sid: sidFile(name),
    ready: readyFile(name),
    sendAt: sendAtFile(name),
  }
}

export class ClaudeTeammateRecord extends TeammateRecord {
  readonly engine: EngineKind = 'claude'

  constructor(args: {
    name: TeammateName
    cwd: string
    createdAt: number
    displayName: string | null
  }) {
    super(args)
  }

  /** The tmux session name this teammate is launched as. */
  tmuxSession(): string {
    return tmuxSessionName(this.name)
  }

  /** The Claude-engine extension paths for this teammate. */
  extension(): ClaudeTeammateExtension {
    return claudeExtensionFor(this.name)
  }

  override engineExtensionFiles(): readonly string[] {
    const ext = this.extension()
    return [ext.cwd, ext.sid, ext.ready, ext.sendAt]
  }
}
