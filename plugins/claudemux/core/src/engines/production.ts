/**
 * Production engine wiring for one `tm` process.
 *
 * Phase 2a registers the Claude engine; Phase 2b registers the Codex
 * engine. Keep both registrations in this one invocation-scoped helper so
 * verb defaults see the full fleet.
 */

import type { NativeEnv } from '../native'
import { ClaudeEngine } from './claude/claude-engine'
import { CodexEngine } from './codex/engine'
import { EngineRegistry } from './registry'

export function productionRegistry(env: NativeEnv): EngineRegistry {
  const registry = new EngineRegistry()
  registry.register(new ClaudeEngine(env))
  registry.register(new CodexEngine())
  return registry
}
