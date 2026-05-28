/**
 * The identity store — the one place that writes and reads
 * `/tmp/teammate-<name>.json`. Decision multi-engine-tui-architecture §"TeammateRecord" anchors this
 * file as the single source of truth for the base `TeammateRecord`, and
 * §"Enforcement against silent regression" pins the constraint: no other
 * file in `plugins/claudemux/core/src/` may touch the JSON marker.
 *
 * Three surfaces matter:
 *
 *  - `reserve(record)` is the spawn-time write. It uses `O_CREAT | O_EXCL`
 *    against `/tmp/teammate-<name>.json`; a second concurrent `tm spawn`
 *    of the same name fails with `EEXIST`, which the verb formats as a
 *    "name already taken" error. Decision multi-engine-tui-architecture §"Engine identity is the
 *    JSON's `engine` field" makes this the authoritative race winner —
 *    whichever engine reserves first owns the name, the loser sees
 *    `already-exists`. The reservation is atomic enough on POSIX rename
 *    semantics that a `tm spawn ... --engine claude` on one terminal
 *    and a `tm spawn ... --engine codex` on another in the same
 *    millisecond never both succeed.
 *
 *  - `read(name)` is the per-verb identity lookup. The router calls it
 *    once per CLI invocation to map a teammate name to its engine kind.
 *    Returns `null` for "no such teammate" (the data outcome, not an
 *    error).
 *
 *  - `list()` enumerates every reserved teammate by reading
 *    `/tmp/teammate-*.json`. Decision multi-engine-tui-architecture §"Verb is the abstraction"
 *    relies on this for `tm ls`'s engine-agnostic listing — the verb
 *    asks for "every teammate identity" without knowing per-engine
 *    persistence shapes.
 *
 *  - `remove(name)` is `tm kill`'s identity bookkeeping. The verb calls
 *    it after a successful kill so a later `tm spawn` of the same name
 *    is not blocked by a stale identity file.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  atomicWrite,
  readIfPresent,
  removeIfPresent,
  reserveExclusive,
} from './atomic-file'
import {
  TEAMMATE_RECORD_SCHEMA,
  type TeammateRecordJson,
} from '../engines/teammate-record'
import type { EngineKind, TeammateName } from '../engines/types'

/**
 * The directory the identity files live in. Defaults to `/tmp` (the
 * cross-process protocol root); tests point this at a fresh temp
 * directory via `CLAUDEMUX_IDENTITY_ROOT` so a unit test can drive
 * `reserve` / `read` / `list` without colliding with real dispatcher
 * state. Resolved per call so a test that sets the env var inside
 * `beforeEach` is honoured by code paths that captured the module
 * earlier.
 */
function identityRoot(): string {
  return process.env['CLAUDEMUX_IDENTITY_ROOT'] || '/tmp'
}

/** Absolute path of the identity JSON for a teammate. */
export function identityFile(name: TeammateName): string {
  return `${identityRoot()}/teammate-${name}.json`
}

/**
 * Directory holding archived identity records — written when `tm kill`
 * tears down a teammate, so a later `tm resume <name> <sid>` or
 * `tm history <name>` can look up the killed teammate's cwd / repo /
 * worktreeSlug / displayName without the agent reading `/tmp` files
 * by hand.
 *
 * Lives under `identityRoot()` so `CLAUDEMUX_IDENTITY_ROOT` covers
 * both the live and archived sides for tests. The directory name has
 * no `.json` suffix, so `TOP_LEVEL_FILENAME` skips it and `list()`
 * never enumerates archived records as live teammates.
 */
function archiveDir(): string {
  return join(identityRoot(), 'teammate-archive')
}

/** Absolute path of the archived identity JSON for a teammate. */
export function archivedIdentityFile(name: TeammateName): string {
  return join(archiveDir(), `${name}.json`)
}

/** Regex pinning the top-level identity-file name shape; capture group 1 is the name. */
const TOP_LEVEL_FILENAME = /^teammate-(.+)\.json$/

export type ReserveResult =
  | { kind: 'reserved' }
  | { kind: 'taken'; existing: TeammateRecordJson }
  | { kind: 'failed'; message: string }

function sleepSync(ms: number): void {
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, ms)
}

function readReservedRecord(name: TeammateName): TeammateRecordJson | null {
  const deadline = Date.now() + 50
  let existing = read(name)
  while (existing === null && Date.now() < deadline) {
    sleepSync(1)
    existing = read(name)
  }
  return existing
}

/**
 * Atomically reserve a teammate name. The exclusive create fails with
 * `EEXIST` if the file already exists — that case is mapped to `taken` and
 * the existing record is read so the verb can format an "already-exists"
 * error that names which engine owns the slot.
 */
export function reserve(record: TeammateRecordJson): ReserveResult {
  const path = identityFile(record.name)
  try {
    reserveExclusive(path, `${JSON.stringify(record, null, 2)}\n`)
    return { kind: 'reserved' }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readReservedRecord(record.name)
      if (existing === null) {
        return { kind: 'failed', message: 'EEXIST on identity file but record could not be read back' }
      }
      return { kind: 'taken', existing }
    }
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Rewrite an existing teammate identity record atomically — used by
 * `commit` after a `reserve` when the engine wants to persist data computed
 * after the reservation (Phase 2a does not need this; reserved here for the
 * hook on `/clear` flow where the recorded fields stabilise post-spawn).
 */
export function write(record: TeammateRecordJson): void {
  atomicWrite(identityFile(record.name), `${JSON.stringify(record, null, 2)}\n`)
}

/** Read an identity record; `null` for "no such teammate". */
export function read(name: TeammateName): TeammateRecordJson | null {
  const raw = readIfPresent(identityFile(name))
  if (raw === null) return null
  return parse(raw)
}

/** Remove the identity file; idempotent. */
export function remove(name: TeammateName): void {
  removeIfPresent(identityFile(name))
}

/**
 * Snapshot the live identity record to the archive directory. Called
 * by `tm kill` immediately before the live record is removed; after
 * this call `readArchived(name)` returns the same record that
 * `read(name)` returned just before the kill.
 *
 * No-op when there is no live record — `tm kill` running on a name
 * with only a stale tmux session leaves nothing to archive, and the
 * archive directory stays as it was (carrying the previous kill's
 * snapshot if any). Returns whether anything was archived, so the
 * verb layer can tell apart "archived a real identity" from
 * "nothing to archive".
 */
export function archive(name: TeammateName): boolean {
  const raw = readIfPresent(identityFile(name))
  if (raw === null) return false
  atomicWrite(archivedIdentityFile(name), raw)
  return true
}

/**
 * Read a teammate's archived record — what was on disk the last time
 * `tm kill` archived this name. Returns `null` for "no such archive"
 * (never killed under this scheme, or removed by `removeArchived`).
 */
export function readArchived(name: TeammateName): TeammateRecordJson | null {
  const raw = readIfPresent(archivedIdentityFile(name))
  if (raw === null) return null
  return parse(raw)
}

/** Remove the archived identity file; idempotent. */
export function removeArchived(name: TeammateName): void {
  removeIfPresent(archivedIdentityFile(name))
}

/**
 * Enumerate every reserved teammate. Schema 2 made names flat (no `/`),
 * so only the top-level `/tmp/teammate-*.json` files need scanning.
 *
 * The Codex engine's per-teammate registry directory
 * (`/tmp/teammate-codex/<name>/`) is a directory, not a `*.json` file,
 * so it does not match `TOP_LEVEL_FILENAME` and is skipped silently.
 *
 * Unparseable files are skipped (the caller does not get a partial
 * record). A schema=1 record on disk parses as `null` (no
 * back-compat read in schema 2's one-step cut) and is treated the
 * same as a missing teammate — the verb that reads it will surface
 * the migration error.
 */
export function list(): readonly TeammateRecordJson[] {
  const out: TeammateRecordJson[] = []
  let entries: string[]
  try {
    entries = readdirSync(identityRoot())
  } catch {
    return []
  }
  for (const entry of entries) {
    const top = entry.match(TOP_LEVEL_FILENAME)
    if (top === null) continue
    let info: ReturnType<typeof statSync>
    try {
      info = statSync(join(identityRoot(), entry))
    } catch {
      continue
    }
    if (!info.isFile()) continue
    const raw = readIfPresent(join(identityRoot(), entry))
    if (raw === null) continue
    const parsed = parse(raw)
    if (parsed !== null) out.push(parsed)
  }
  return out
}

/**
 * Parse a raw JSON file into a `TeammateRecordJson`. Returns `null` if
 * the shape doesn't match the current schema. Schema 2 is the
 * name/repo decoupling cut — a schema=1 record parses as `null` (no
 * silent back-compat read; the user is expected to `tm kill` legacy
 * teammates before upgrading).
 */
function parse(raw: string): TeammateRecordJson | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const obj = value as Record<string, unknown>
  if (obj['schema'] !== TEAMMATE_RECORD_SCHEMA) return null
  if (typeof obj['name'] !== 'string') return null
  if (typeof obj['engine'] !== 'string') return null
  if (typeof obj['repo'] !== 'string') return null
  if (typeof obj['cwd'] !== 'string') return null
  if (typeof obj['createdAt'] !== 'number') return null
  const worktreeSlug = obj['worktreeSlug']
  if (worktreeSlug !== null && typeof worktreeSlug !== 'string') return null
  const displayName = obj['displayName']
  if (displayName !== null && typeof displayName !== 'string') return null
  // The engine union is not validated against EngineKind here — an unknown
  // engine kind on disk is "no such teammate from this build's view"
  // (the router maps it through the registry, which will return undefined
  // and the verb formats it as not-found).
  return {
    schema: TEAMMATE_RECORD_SCHEMA,
    name: obj['name'],
    engine: obj['engine'] as EngineKind,
    repo: obj['repo'],
    cwd: obj['cwd'],
    worktreeSlug: worktreeSlug as string | null,
    createdAt: obj['createdAt'],
    displayName: displayName as string | null,
  }
}

/**
 * Read the on-disk JSON for a teammate without enforcing schema
 * version. Returns the `schema` field as a number when present —
 * used by the dispatch layer to detect a legacy schema=1 record and
 * print a migration hint instead of silently treating it as missing.
 */
export function readRawSchema(name: TeammateName): number | null {
  const raw = readIfPresent(identityFile(name))
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value !== 'object' || value === null) return null
    const schema = (value as Record<string, unknown>)['schema']
    return typeof schema === 'number' ? schema : null
  } catch {
    return null
  }
}
