/**
 * Coverage for the identity router: it may ask a migrator to materialise
 * a missing base record, but it only resolves after reading
 * `/tmp/teammate-<name>.json`.
 */

import { mkdtempSync, rmSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { ProductionTeammateRouter } from '../../src/identity/router'
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
import { TEAMMATE_RECORD_SCHEMA } from '../../src/engines/teammate-record'
import { read, write } from '../../src/persistence/identity-store'

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

class StubEngine implements Engine {
  readonly capabilities = capabilities

  constructor(readonly kind: EngineKind) {}

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

let savedIdentityRoot: string | undefined
let identityRoot: string

beforeEach(() => {
  savedIdentityRoot = process.env['CLAUDEMUX_IDENTITY_ROOT']
  identityRoot = mkdtempSync('/tmp/cmx-router-id-')
  process.env['CLAUDEMUX_IDENTITY_ROOT'] = identityRoot
})

afterEach(() => {
  if (savedIdentityRoot === undefined) delete process.env['CLAUDEMUX_IDENTITY_ROOT']
  else process.env['CLAUDEMUX_IDENTITY_ROOT'] = savedIdentityRoot
  rmSync(identityRoot, { recursive: true, force: true })
})

function registryWithEngines(): EngineRegistry {
  const registry = new EngineRegistry()
  registry.register(new StubEngine('claude'))
  registry.register(new StubEngine('codex'))
  return registry
}

describe('ProductionTeammateRouter', () => {
  test('resolves by reading the recorded engine identity', async () => {
    write({
      schema: TEAMMATE_RECORD_SCHEMA,
      name: 'worker',
      engine: 'codex',
      repo: '/tmp',
      cwd: '/tmp',
      worktreeSlug: null,
      createdAt: 1,
      displayName: null,
    })

    const resolved = await new ProductionTeammateRouter(registryWithEngines()).resolve('worker')

    expect(resolved?.name).toBe('worker')
    expect(resolved?.engine.kind).toBe('codex')
  })

  test('runs a missing-identity migrator and then resolves through the JSON', async () => {
    const migrated: string[] = []
    const router = new ProductionTeammateRouter(registryWithEngines(), async (name) => {
      migrated.push(name)
      write({
        schema: TEAMMATE_RECORD_SCHEMA,
        name,
        engine: 'claude',
        repo: '/tmp',
        cwd: '/tmp',
        worktreeSlug: null,
        createdAt: 1,
        displayName: null,
      })
    })

    const resolved = await router.resolve('legacy')

    expect(migrated).toEqual(['legacy'])
    expect(read('legacy')).toMatchObject({ name: 'legacy', engine: 'claude' })
    expect(resolved?.engine.kind).toBe('claude')
  })

  test('returns null when no identity exists after migration', async () => {
    const resolved = await new ProductionTeammateRouter(
      registryWithEngines(),
      async () => {},
    ).resolve('missing')

    expect(resolved).toBeNull()
  })

  test('returns null on an invalid name without migrating', async () => {
    let migrated = false
    const resolved = await new ProductionTeammateRouter(registryWithEngines(), async () => {
      migrated = true
    }).resolve('a//b')

    expect(resolved).toBeNull()
    expect(migrated).toBe(false)
  })
})
