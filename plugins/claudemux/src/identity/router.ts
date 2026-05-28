/**
 * Resolve a teammate name to the engine that owns it. Decision multi-engine-tui-architecture
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
 * The production wiring may pass an identity migrator for already-running
 * teammates that predate the base JSON. That migrator is allowed to
 * materialise `/tmp/teammate-<name>.json`; the router still routes only by
 * re-reading the JSON afterwards.
 */

import { read as readIdentity } from '../persistence/identity-store'
import { validateTeammateName } from './name'
import type { Engine } from '../engines/engine'
import type { EngineRegistryView } from '../engines/registry'
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

/** Optional one-shot materialisation for pre-identity running teammates. */
export type IdentityMigrator = (name: TeammateName) => Promise<void>

/**
 * Production router. Reads the base TeammateRecord JSON via the identity
 * store; looks up the engine for the recorded kind through the registry.
 * If either step misses, the result is `null` and the verb formats
 * "no such teammate".
 *
 * A teammate whose JSON records an engine kind that this process has
 * not registered (e.g. a stale `codex` record while running a build
 * without Codex wired up) also resolves to `null` — the verb says "no
 * such teammate" rather than crashing on `engines.get(undefined)`.
 */
export class ProductionTeammateRouter implements TeammateRouter {
  constructor(
    private readonly engines: EngineRegistryView,
    private readonly migrateMissingIdentity: IdentityMigrator | null = null,
  ) {}

  async resolve(name: TeammateName): Promise<ResolvedTeammate | null> {
    if (validateTeammateName(name).kind !== 'ok') return null
    let record = readIdentity(name)
    if (record === null && this.migrateMissingIdentity !== null) {
      await this.migrateMissingIdentity(name)
      record = readIdentity(name)
    }
    if (record === null) return null
    const engine = this.engines.get(record.engine)
    if (engine === undefined) return null
    return { name, engine }
  }
}

/**
 * Test-only router. Returns `null` for every name. Phase 1 used this as
 * the default; Phase 2a keeps it for tests that need to exercise the
 * "not found" branch without setting up the identity store.
 */
export class EmptyTeammateRouter implements TeammateRouter {
  async resolve(_name: TeammateName): Promise<ResolvedTeammate | null> {
    return null
  }
}
