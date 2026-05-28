/**
 * The engine registry — one place where every concrete engine
 * registers itself, and every verb-layer default implementation pulls
 * the engines it needs to fan out over.
 *
 * Decision multi-engine-tui-architecture §"Verb is the abstraction" leans on this seam: `tm ls`
 * iterates `registered()` and concatenates `Engine.list()` rows; the
 * status / kill verbs resolve a teammate's engine through the identity
 * router (decision multi-engine-tui-architecture §"Engine identity is the JSON's `engine` field")
 * and the registry hands back the implementation. Phase 1 ships the
 * empty registry; Phase 2a registers the Claude engine, Phase 2b
 * registers the Codex engine.
 *
 * The registry is invocation-scoped: each `tm` process creates one,
 * the production wiring populates it, tests inject their own. There is
 * no module-level singleton.
 */

import type { Engine } from './engine'
import type { EngineKind } from './types'

/**
 * A read-only view of registered engines. Verb-layer default impls
 * accept this view (not the mutable registry), so a verb cannot
 * accidentally re-register an engine mid-dispatch.
 */
export interface EngineRegistryView {
  /** Look up by kind; `undefined` when no engine of that kind is registered. */
  get(kind: EngineKind): Engine | undefined
  /** Every registered engine, in deterministic order (insertion order). */
  registered(): readonly Engine[]
  /** Every kind currently registered. */
  kinds(): readonly EngineKind[]
}

/**
 * The mutable registry. The production wiring constructs one of these,
 * registers each engine implementation, then hands the view to the
 * verb dispatcher.
 */
export class EngineRegistry implements EngineRegistryView {
  private readonly engines: Map<EngineKind, Engine> = new Map()

  /** Add an engine; throws if a kind is registered twice in one process. */
  register(engine: Engine): void {
    if (this.engines.has(engine.kind)) {
      throw new Error(
        `EngineRegistry.register: engine '${engine.kind}' is already registered in this process`,
      )
    }
    this.engines.set(engine.kind, engine)
  }

  get(kind: EngineKind): Engine | undefined {
    return this.engines.get(kind)
  }

  registered(): readonly Engine[] {
    return Array.from(this.engines.values())
  }

  kinds(): readonly EngineKind[] {
    return Array.from(this.engines.keys())
  }
}

/** Convenience constructor for tests / empty production wiring. */
export function emptyRegistry(): EngineRegistry {
  return new EngineRegistry()
}
