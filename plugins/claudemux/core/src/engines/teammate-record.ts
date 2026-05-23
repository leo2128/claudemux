/**
 * The single source of truth for a teammate's identity. Decision 0024
 * §"TeammateRecord — one base JSON, engine-private extensions, hooks-
 * managed files left alone" collapses what `tm` itself writes and reads
 * (engine, cwd, createdAt, …) into one JSON at `/tmp/teammate-<name>.json`;
 * engine-private state lives under the engine's persistence module;
 * hooks-managed marker files (`.busy`, `.last`, `.sid`, `.ready`, idle
 * marker) stay separate because Bash hooks cannot atomically rewrite
 * JSON.
 *
 * `TeammateRecord` is the abstract base every per-engine record extends.
 * It owns the JSON-serialised base fields plus the `markerPath(name)`
 * builder (one named function, so the file shape is changed in one
 * place — decision 0004's path-builder discipline). A subclass declares
 * its engine-private extension files via `engineExtensionFiles()`, which
 * `tm doctor` consumes to enumerate everything to reap for a given
 * teammate.
 *
 * Phase 1 lands the base + the abstract seam. Phase 2a (Claude) and
 * Phase 2b (Codex) override `engineExtensionFiles()` and the engine's
 * file builders. The Phase 1 stubs in `engines/<kind>/persistence.ts`
 * throw `not implemented in Phase 1` from the abstract slot.
 */

import type { EngineKind, TeammateName } from './types'

/** Current on-disk schema for `/tmp/teammate-<name>.json`. */
export const TEAMMATE_RECORD_SCHEMA = 1 as const

/** The JSON shape `tm` writes at spawn and reads on every verb. */
export interface TeammateRecordJson {
  readonly schema: typeof TEAMMATE_RECORD_SCHEMA
  readonly name: TeammateName
  readonly engine: EngineKind
  readonly cwd: string
  readonly createdAt: number
  readonly displayName: string | null
}

/**
 * Base carrier for a teammate identity. Subclasses live under
 * `engines/<kind>/persistence.ts` and add engine-private file builders
 * (e.g., `.cwd`, `.sid`, `/tmp/teammate-codex/<name>/socket`); the base
 * fields are written once by the registry layer and never mutated.
 */
export abstract class TeammateRecord {
  readonly schema: typeof TEAMMATE_RECORD_SCHEMA = TEAMMATE_RECORD_SCHEMA
  readonly name: TeammateName
  abstract readonly engine: EngineKind
  readonly cwd: string
  readonly createdAt: number
  readonly displayName: string | null

  protected constructor(args: {
    name: TeammateName
    cwd: string
    createdAt: number
    displayName: string | null
  }) {
    this.name = args.name
    this.cwd = args.cwd
    this.createdAt = args.createdAt
    this.displayName = args.displayName
  }

  /**
   * Absolute path of the base JSON file for this teammate. The single
   * builder so the file shape changes in one place.
   */
  static markerPath(name: TeammateName): string {
    return `/tmp/teammate-${name}.json`
  }

  /** Serialise this record's base fields to the on-disk JSON shape. */
  toJson(): TeammateRecordJson {
    return {
      schema: this.schema,
      name: this.name,
      engine: this.engine,
      cwd: this.cwd,
      createdAt: this.createdAt,
      displayName: this.displayName,
    }
  }

  /**
   * The engine-private files that belong to this teammate. `tm doctor`
   * walks this list when reaping an orphaned identity. The base file
   * (`/tmp/teammate-<name>.json`) is not part of the list — the
   * registry layer owns it.
   */
  abstract engineExtensionFiles(): readonly string[]
}
