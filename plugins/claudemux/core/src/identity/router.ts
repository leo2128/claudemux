/**
 * Resolve a teammate name to the engine that owns it. Decision 0024
 * §"Engine identity is the JSON's `engine` field" sets the rule: the
 * router reads `/tmp/teammate-<name>.json` and routes by the `engine`
 * field — no "infer from which registry directory exists" path, no
 * legacy `codex-` prefix fallback.
 *
 * The verb-layer default impls (`statusVerb`, `killVerb`, every
 * single-teammate verb) call `router.resolve(name)`; a `null` return
 * is the "no such teammate" case the verb formats. The router never
 * throws on a missing teammate — that is data, not an error.
 *
 * Phase 1 ships the interface plus `EmptyTeammateRouter`, which always
 * returns `null`. Phase 2 replaces it with the production router that
 * reads the identity store and consults the registry; the verb code
 * does not change.
 */

import type { Engine } from '../engines/engine'
import type { TeammateName } from '../engines/types'

/** One resolved teammate — the name plus the engine that owns it. */
export interface ResolvedTeammate {
  readonly name: TeammateName
  readonly engine: Engine
}

/** The seam every single-teammate verb consults. */
export interface TeammateRouter {
  /** `null` means "no teammate by that name" — a data outcome, not an error. */
  resolve(name: TeammateName): Promise<ResolvedTeammate | null>
}

/**
 * Phase 1 router — always resolves to `null`. The Phase 1 registry is
 * empty, so no name can resolve; this implementation makes that the
 * explicit behavior instead of relying on a partial / missing file.
 */
export class EmptyTeammateRouter implements TeammateRouter {
  async resolve(_name: TeammateName): Promise<ResolvedTeammate | null> {
    return null
  }
}
