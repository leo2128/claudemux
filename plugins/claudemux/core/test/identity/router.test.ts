/**
 * Coverage for `LegacyClaudeTmuxRouter` — the Phase 2a-1 transitional
 * router that resolves a teammate by tmux session probe when the base
 * TeammateRecord JSON does not exist yet.
 *
 * The regression case is the legacy single-segment name `flow__1`:
 * Phase 2a-1's first cut rejected `__` in raw names and then encoded
 * `/` → `__` for tmux, which made `tm status flow__1` unreachable
 * even when the session `teammate-flow__1` was alive. The fix keeps
 * `__` legal in flat names and lets the legacy probe succeed.
 */

import { describe, expect, test } from 'vitest'

import { LegacyClaudeTmuxRouter } from '../../src/identity/router'
import { EngineRegistry } from '../../src/engines/registry'
import type { Engine } from '../../src/engines/engine'
import type {
  CompactRequest,
  CompactResult,
  ContextRequest,
  ContextResult,
  DoctorSection,
  EngineCapabilities,
  EngineContext,
  EngineKind,
  EngineSnapshot,
  HistoryRequest,
  HistoryResult,
  InspectRequest,
  KillRequest,
  KillResult,
  LastRequest,
  MemoryRequest,
  ReloadRequest,
  ReloadResult,
  ResumeRequest,
  ResumeResult,
  SendRequest,
  SpawnRequest,
  SpawnResult,
  StatusRequest,
  TeammateListing,
  TeammateStatus,
  TextResult,
  TurnResult,
  WaitRequest,
} from '../../src/engines/types'

const capabilities: EngineCapabilities = {
  atomicSend: true,
  atomicSpawnPrompt: true,
  compaction: 'manual',
  contextUsage: 'transcript-jsonl',
  history: 'transcript-files',
  memory: 'claude-project-memory',
  reload: 'prompt-command',
  resume: 'transcript-id',
  detachedTurn: 'replayable',
  events: 'synthesized',
}

class StubClaudeEngine implements Engine {
  readonly kind: EngineKind = 'claude'
  readonly capabilities = capabilities

  async spawn(req: SpawnRequest, _ctx: EngineContext): Promise<SpawnResult> {
    return { kind: 'spawned', name: req.name, firstTurn: null }
  }
  async send(_req: SendRequest, _ctx: EngineContext): Promise<TurnResult> {
    return { kind: 'completed', text: '', items: [], context: null }
  }
  async wait(_req: WaitRequest, _ctx: EngineContext): Promise<TurnResult> {
    return { kind: 'completed', text: '', items: [], context: null }
  }
  async kill(_req: KillRequest, _ctx: EngineContext): Promise<KillResult> {
    return { kind: 'killed' }
  }
  async list(_ctx: EngineContext): Promise<readonly TeammateListing[]> {
    return []
  }
  async status(_req: StatusRequest, _ctx: EngineContext): Promise<TeammateStatus> {
    return { kind: 'not-found' }
  }
  async compact(_req: CompactRequest, _ctx: EngineContext): Promise<CompactResult> {
    return { kind: 'not-supported', reason: 'stub' }
  }
  async resume(_req: ResumeRequest, _ctx: EngineContext): Promise<ResumeResult> {
    return { kind: 'not-supported', reason: 'stub' }
  }
  async last(_req: LastRequest, _ctx: EngineContext): Promise<TextResult> {
    return { kind: 'text', text: '' }
  }
  async ctx(_req: ContextRequest, _ctx: EngineContext): Promise<ContextResult> {
    return { kind: 'not-supported', reason: 'stub' }
  }
  async history(_req: HistoryRequest, _ctx: EngineContext): Promise<HistoryResult> {
    return { kind: 'not-supported', reason: 'stub' }
  }
  async mem(_req: MemoryRequest, _ctx: EngineContext): Promise<TextResult> {
    return { kind: 'not-supported', reason: 'stub' }
  }
  async reload(_req: ReloadRequest, _ctx: EngineContext): Promise<ReloadResult> {
    return { kind: 'not-supported', reason: 'stub' }
  }
  async inspect(req: InspectRequest, _ctx: EngineContext): Promise<EngineSnapshot> {
    return { engine: this.kind, name: req.name, fields: {} }
  }
  async doctor(_ctx: EngineContext): Promise<DoctorSection> {
    return { engine: this.kind, findings: [] }
  }
}

function registryWithClaude(): EngineRegistry {
  const registry = new EngineRegistry()
  registry.register(new StubClaudeEngine())
  return registry
}

describe('LegacyClaudeTmuxRouter', () => {
  test('resolves a flat legacy name containing __ when the raw tmux session exists', async () => {
    const probed: string[] = []
    const router = new LegacyClaudeTmuxRouter(registryWithClaude(), async (session) => {
      probed.push(session)
      return session === 'teammate-flow__1'
    })
    const resolved = await router.resolve('flow__1')
    expect(probed).toEqual(['teammate-flow__1'])
    expect(resolved?.name).toBe('flow__1')
    expect(resolved?.engine.kind).toBe('claude')
  })

  test('resolves a nested name by encoding / → __ in the probe', async () => {
    const probed: string[] = []
    const router = new LegacyClaudeTmuxRouter(registryWithClaude(), async (session) => {
      probed.push(session)
      return session === 'teammate-flow__flow-1'
    })
    const resolved = await router.resolve('flow/flow-1')
    expect(probed).toEqual(['teammate-flow__flow-1'])
    expect(resolved?.name).toBe('flow/flow-1')
  })

  test('returns null when the probed session does not exist', async () => {
    const router = new LegacyClaudeTmuxRouter(registryWithClaude(), async () => false)
    expect(await router.resolve('missing')).toBeNull()
  })

  test('returns null on an invalid name without probing', async () => {
    let probed = false
    const router = new LegacyClaudeTmuxRouter(registryWithClaude(), async () => {
      probed = true
      return true
    })
    expect(await router.resolve('a//b')).toBeNull()
    expect(probed).toBe(false)
  })
})
