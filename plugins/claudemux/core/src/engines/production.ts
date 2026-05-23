/**
 * Production engine wiring for one `tm` process.
 *
 * Phase 2b registers the Codex engine here. Phase 2a owns the Claude
 * engine implementation and will replace the TODO with the concrete
 * registration when that branch lands.
 */

import { CodexEngine } from './codex/engine'
import { EngineRegistry } from './registry'

export function productionRegistry(): EngineRegistry {
  const registry = new EngineRegistry()
  registry.register(new CodexEngine())
  // TODO(phase-2a): registry.register(new ClaudeEngine())
  return registry
}
