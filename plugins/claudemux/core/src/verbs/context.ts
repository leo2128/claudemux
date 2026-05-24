/**
 * `VerbContext` — the dependency bundle every verb-layer default impl
 * takes. Decision 0024 §"Verb is the abstraction" calls out the four
 * verb-side primitives:
 *
 *  - `engines` — the read-only registry view; `lsVerb` / `statesVerb`
 *    fan out over `registered()`.
 *  - `router` — name → engine resolution; `statusVerb` / `killVerb` /
 *    every single-teammate verb consults this. `null` is the
 *    "no such teammate" case.
 *  - `engineContext` — the shared environment every Engine method
 *    receives; verbs pass it through unmodified.
 *  - `identity` — the writer for the base `/tmp/teammate-<name>.json`
 *    file; `killVerb` calls `remove()` after a successful kill so a
 *    later `tm spawn` of the same name is not blocked by a stale
 *    identity record.
 *
 * Phase 1 has no concrete engines and no real identity store; the
 * verbs still type-check against this bundle, and the empty / no-op
 * Phase 1 implementations land them on the "not found" branch.
 */

import type { ColumnRunner } from '../column'
import type { EngineRegistryView } from '../engines/registry'
import type { EngineContext, TeammateName } from '../engines/types'
import type { TeammateRouter } from '../identity/router'

/**
 * Writer for the base TeammateRecord JSON. Decision 0024's "identity-
 * by-JSON" enforcement rule pins this as the only place that mutates
 * `/tmp/teammate-<name>.json`; Phase 2 lands the production
 * implementation under `persistence/identity-store.ts`.
 */
export interface IdentityStore {
  /** Remove the identity JSON for `name`. Idempotent — missing file is OK. */
  remove(name: TeammateName): Promise<void>
}

export interface VerbContext {
  readonly engines: EngineRegistryView
  readonly router: TeammateRouter
  readonly engineContext: EngineContext
  readonly identity: IdentityStore
  /**
   * Column-aligner. `tm states` owns the table layout, so the verb layer
   * — not the engine — holds the `column -t` runner. Engines stay in
   * the structured-row business.
   */
  readonly runColumn: ColumnRunner
}

/** Phase 1 no-op identity store — Phase 2 ships the real writer. */
export class NoopIdentityStore implements IdentityStore {
  async remove(_name: TeammateName): Promise<void> {
    return
  }
}
