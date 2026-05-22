/**
 * The teammate registry — the core's authoritative record of the teammate
 * set (see `.agents/components/claudemux-core.md`).
 *
 * Why it exists: `tmux ls` cannot be the enumeration source for the `next`
 * line. A Codex teammate (Phase C) is a persisted thread with no tmux
 * session, so a tmux query cannot see it. The registry is the agent-neutral
 * record that can.
 *
 * Phase A scope: the registry tracks Claude teammates only, is written by the
 * core's `spawn`/`resume`/`kill` tool handlers, and must survive a core
 * restart (the Phase A exit gate). Two durability properties carry that:
 *
 *  - **Atomic writes.** Every save is a write to a sibling `.tmp` file
 *    followed by a `rename`. A crash mid-save can leave a stale `.tmp` but
 *    never a torn `registry.json` — the rename is atomic on one filesystem.
 *  - **Tolerant loads.** A missing, truncated, or unparseable file loads as
 *    an empty registry rather than throwing. A core that crashes its way
 *    into a bad file must still start; it reconciles from there.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * On-disk schema version. Bump only on a breaking change to `TeammateEntry`
 * or `RegistryFileShape`. A file written under a different version loads as
 * empty — Phase A ships no migration path, by design: the registry is
 * rebuildable from the live teammate set, so a discard-and-reconcile is safe
 * and a migration codepath would be carried weight with no first user.
 */
export const REGISTRY_SCHEMA_VERSION = 1

/** One teammate, as the core records it. */
export interface TeammateEntry {
  /** The teammate key — the sibling repository's directory name. */
  repo: string
  /**
   * The hosting agent family. Phase A records only `claude`; the field is
   * present now so a Codex teammate (Phase C) needs no schema bump.
   */
  agent: 'claude'
  /**
   * The teammate's current Claude Code `session_id`, or `null` when the core
   * recorded the teammate before a session_id was observable. A session_id
   * rotates on `/clear` and `/resume`, so it is a mutable field, not a key.
   */
  sid: string | null
  /** The teammate's physical working directory at spawn time, when known. */
  cwd: string | null
  /** When the core first recorded this teammate (ISO-8601). */
  spawnedAt: string
  /** When the core last confirmed this teammate (ISO-8601). */
  observedAt: string
}

/** What `record` needs to upsert a teammate. */
export interface TeammateInput {
  repo: string
  sid: string | null
  cwd: string | null
  agent?: 'claude'
}

/** The on-disk file shape. */
interface RegistryFileShape {
  schemaVersion: number
  teammates: TeammateEntry[]
}

/** The teammate registry, backed by one JSON file. */
export class Registry {
  readonly #file: string
  readonly #now: () => number
  #teammates: TeammateEntry[] = []

  /**
   * @param file Path to `registry.json`.
   * @param now  Injected clock (epoch millis); defaults to `Date.now`.
   */
  constructor(file: string, now: () => number = Date.now) {
    this.#file = file
    this.#now = now
  }

  /**
   * Load the registry from disk into memory. A missing, truncated, or
   * otherwise unreadable file — and a file written under a different schema
   * version — loads as an empty registry without throwing. Individual
   * malformed entries are dropped; valid siblings survive.
   */
  load(): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
    } catch {
      this.#teammates = []
      return
    }
    this.#teammates = readTeammates(parsed)
  }

  /** Every recorded teammate. */
  list(): TeammateEntry[] {
    return [...this.#teammates]
  }

  /** One teammate by repo, or `undefined`. */
  get(repo: string): TeammateEntry | undefined {
    return this.#teammates.find((t) => t.repo === repo)
  }

  /**
   * Upsert a teammate and persist. An existing teammate keeps its original
   * `spawnedAt` — `record` is also how `resume` re-registers a teammate, and
   * a resume does not restart its lifetime — while `sid`, `cwd`, and
   * `observedAt` are refreshed.
   */
  record(input: TeammateInput): void {
    const stamp = new Date(this.#now()).toISOString()
    const existing = this.get(input.repo)
    const entry: TeammateEntry = {
      repo: input.repo,
      agent: input.agent ?? 'claude',
      sid: input.sid,
      cwd: input.cwd,
      spawnedAt: existing?.spawnedAt ?? stamp,
      observedAt: stamp,
    }
    this.#teammates = [...this.#teammates.filter((t) => t.repo !== input.repo), entry]
    this.#save()
  }

  /** Remove a teammate and persist. Removing an absent teammate is a no-op. */
  remove(repo: string): void {
    const next = this.#teammates.filter((t) => t.repo !== repo)
    if (next.length === this.#teammates.length) return
    this.#teammates = next
    this.#save()
  }

  /**
   * Drop every teammate the liveness predicate rejects, persist if anything
   * changed, and return the dropped entries. Run at core startup: a registry
   * reloaded after a crash can name teammates that were killed while the core
   * was down, and reconciliation is what makes the reloaded registry true
   * again.
   */
  reconcile(isAlive: (entry: TeammateEntry) => boolean): TeammateEntry[] {
    const live: TeammateEntry[] = []
    const dropped: TeammateEntry[] = []
    for (const entry of this.#teammates) {
      // Evaluate the predicate exactly once per entry. It observes the
      // filesystem, so a second call could disagree — and a split decision
      // would drop an entry from the returned set while still removing it,
      // or the reverse.
      if (isAlive(entry)) live.push(entry)
      else dropped.push(entry)
    }
    if (dropped.length === 0) return []
    this.#teammates = live
    this.#save()
    return dropped
  }

  /** Atomically write the in-memory state: write a `.tmp` sibling, then rename. */
  #save(): void {
    const file: RegistryFileShape = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      teammates: this.#teammates,
    }
    mkdirSync(dirname(this.#file), { recursive: true })
    const tmp = `${this.#file}.tmp`
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`)
    renameSync(tmp, this.#file)
  }
}

/**
 * Extract the teammate array from parsed JSON. Returns `[]` for anything that
 * is not a registry file of the current schema version; drops individual
 * entries that do not parse.
 */
function readTeammates(parsed: unknown): TeammateEntry[] {
  if (typeof parsed !== 'object' || parsed === null) return []
  const file = parsed as Partial<RegistryFileShape>
  if (file.schemaVersion !== REGISTRY_SCHEMA_VERSION) return []
  if (!Array.isArray(file.teammates)) return []
  const out: TeammateEntry[] = []
  for (const raw of file.teammates) {
    const entry = parseEntry(raw)
    if (entry) out.push(entry)
  }
  return out
}

/** Validate one raw entry, or return `null` to drop it. */
function parseEntry(raw: unknown): TeammateEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.repo !== 'string' || r.repo.length === 0) return null
  if (r.agent !== 'claude') return null
  if (typeof r.spawnedAt !== 'string' || typeof r.observedAt !== 'string') return null
  const sid = typeof r.sid === 'string' ? r.sid : null
  const cwd = typeof r.cwd === 'string' ? r.cwd : null
  return { repo: r.repo, agent: 'claude', sid, cwd, spawnedAt: r.spawnedAt, observedAt: r.observedAt }
}
