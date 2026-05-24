/**
 * The identity store — the one place that writes and reads
 * `/tmp/teammate-<name>.json`. Decision 0024 §"TeammateRecord" anchors this
 * file as the single source of truth for the base `TeammateRecord`, and
 * §"Enforcement against silent regression" pins the constraint: no other
 * file in `plugins/claudemux/core/src/` may touch the JSON marker.
 *
 * Three surfaces matter:
 *
 *  - `reserve(record)` is the spawn-time write. It uses `O_CREAT | O_EXCL`
 *    against `/tmp/teammate-<name>.json`; a second concurrent `tm spawn`
 *    of the same name fails with `EEXIST`, which the verb formats as a
 *    "name already taken" error. Decision 0024 §"Engine identity is the
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
 *    `/tmp/teammate-*.json`. Decision 0024 §"Verb is the abstraction"
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

/** Regex pinning the top-level identity-file name shape; capture group 1 is the name. */
const TOP_LEVEL_FILENAME = /^teammate-(.+)\.json$/
/** Regex pinning the per-nested-segment directory shape under `/tmp`. */
const NESTED_TOP_DIR = /^teammate-(.+)$/

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
 * Enumerate every reserved teammate. Decision 0024 §"Nested teammate
 * names" allows `flow/flow-1` as a name; the identity file is then
 * `/tmp/teammate-flow/flow-1.json`. A flat `readdir('/tmp')` would miss
 * the nested case, so this function scans:
 *
 *  - the top-level `/tmp/teammate-*.json` (single-segment names), and
 *  - every `/tmp/teammate-<seg>/` directory (the first nested segment),
 *    recursively, for `*.json` files whose path back-resolves to a valid
 *    teammate name.
 *
 * The Codex engine's per-teammate registry directory
 * (`/tmp/teammate-codex/<name>/`) lives under the same prefix because a
 * nested teammate `codex/foo` writes its base record at
 * `/tmp/teammate-codex/foo.json` — the registry root is not a directory
 * we can skip wholesale without losing every `codex/*` teammate. The
 * load-bearing defence is the reconstruction check in `walkNested`: a
 * file is included only if its parsed JSON satisfies the
 * `TeammateRecordJson` schema AND the recorded `name` field
 * reconstructs from the path segments. Codex's daemon-state files
 * (`pid`, `socket`, `thread`, `started-at`, `last-seen`) are not
 * `.json`; the `meta.json` is `.json` but lacks `engine`/`createdAt`
 * and its `name` field does not match the path it lives at, so the
 * parse and reconstruction checks both reject it.
 *
 * Unparseable files are skipped (the caller does not get a partial
 * record).
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
    if (top !== null) {
      // Single-segment identity file: `teammate-<name>.json`.
      const raw = readIfPresent(join(identityRoot(), entry))
      if (raw === null) continue
      const parsed = parse(raw)
      if (parsed !== null) out.push(parsed)
      continue
    }
    const nested = entry.match(NESTED_TOP_DIR)
    if (nested === null) continue
    const firstSegment = nested[1]
    if (firstSegment === undefined) continue
    // Possible nested-name root: walk it for `*.json` leaves whose path
    // reconstructs a valid teammate name. Multiple levels are allowed
    // (D9 only specifies "/-segmented", not "two-segment").
    walkNested(join(identityRoot(), entry), [firstSegment], out)
  }
  return out
}

/** Recursive helper for `list()` — descend a nested-name root. */
function walkNested(
  dir: string,
  segmentsSoFar: readonly string[],
  out: TeammateRecordJson[],
): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    let info: ReturnType<typeof statSync>
    try {
      info = statSync(path)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      walkNested(path, [...segmentsSoFar, entry], out)
      continue
    }
    if (!info.isFile()) continue
    if (!entry.endsWith('.json')) continue
    const leaf = entry.slice(0, -'.json'.length)
    if (leaf.length === 0) continue
    const raw = readIfPresent(path)
    if (raw === null) continue
    const parsed = parse(raw)
    if (parsed === null) continue
    // Defence in depth: the file's path must reconstruct the recorded
    // `name`. A mismatch would mean the file was placed under a path
    // that doesn't reflect the recorded identity (corruption or manual
    // edit) — skip it rather than emit a contradictory listing.
    const reconstructed = [...segmentsSoFar, leaf].join('/')
    if (parsed.name !== reconstructed) continue
    out.push(parsed)
  }
}

/**
 * Parse a raw JSON file into a `TeammateRecordJson`. Returns `null` if the
 * shape doesn't match — a future schema bump would also need to handle
 * `schema !== 1` here, but Phase 2a only supports schema 1.
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
  if (typeof obj['cwd'] !== 'string') return null
  if (typeof obj['createdAt'] !== 'number') return null
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
    cwd: obj['cwd'],
    createdAt: obj['createdAt'],
    displayName: displayName as string | null,
  }
}
