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
 * Phase 2a lands `ProductionTeammateRouter`, which consults
 * `persistence/identity-store.ts` and the `EngineRegistry` to map a
 * name → engine. `EmptyTeammateRouter` stays as the test-friendly
 * empty-fleet implementation.
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
  constructor(private readonly engines: EngineRegistryView) {}

  async resolve(name: TeammateName): Promise<ResolvedTeammate | null> {
    if (validateTeammateName(name).kind !== 'ok') return null
    const record = readIdentity(name)
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

/**
 * Phase 2a-1 transitional router — Claude teammates may not have their
 * base TeammateRecord JSON yet (Phase 2a-2 writes that). Falls back to
 * a tmux session probe: if `teammate-<encoded-name>` is a live tmux
 * session and the registry has a Claude engine, route there.
 *
 * Phase 2a-2 retires this fallback in favour of the identity-store
 * lookup that `ProductionTeammateRouter` performs. The legacy probe is
 * Claude-only because Codex teammates have no tmux session anyway —
 * they will be served by the identity-store lookup as soon as the
 * Codex engine starts writing the JSON.
 */
export class LegacyClaudeTmuxRouter implements TeammateRouter {
  constructor(
    private readonly engines: EngineRegistryView,
    private readonly tmuxProbe: (sessionName: string) => Promise<boolean>,
  ) {}

  async resolve(name: TeammateName): Promise<ResolvedTeammate | null> {
    if (validateTeammateName(name).kind !== 'ok') return null
    const claude = this.engines.get('claude')
    if (claude === undefined) return null
    // `replace(/\//g, '__')` is a no-op on a flat raw name like
    // `flow__1`, so a legacy single-segment session `teammate-flow__1`
    // still resolves to itself; only names actually containing `/` go
    // through the nested-name encoding.
    const sessionName = `teammate-${name.replace(/\//g, '__')}`
    if (!(await this.tmuxProbe(sessionName))) return null
    return { name, engine: claude }
  }
}

/**
 * Try each router in order; the first non-null result wins. Used to
 * compose `ProductionTeammateRouter` with `LegacyClaudeTmuxRouter`
 * during Phase 2a-1 so a teammate without an identity JSON yet still
 * resolves through the tmux probe.
 */
export class CompositeTeammateRouter implements TeammateRouter {
  constructor(private readonly routers: readonly TeammateRouter[]) {}

  async resolve(name: TeammateName): Promise<ResolvedTeammate | null> {
    for (const r of this.routers) {
      const out = await r.resolve(name)
      if (out !== null) return out
    }
    return null
  }
}
