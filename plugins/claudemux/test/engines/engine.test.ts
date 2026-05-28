/**
 * Phase 1 Engine-contract tests. These tests do not exercise any real
 * engine behavior (Phase 2a / 2b land that). They verify the contract
 * shape decision multi-engine-tui-architecture §"Engine interface" sets:
 *
 *  - A `class implements Engine` with every method (no `?` optionals)
 *    type-checks. The minimal `NoopEngine` defined below would fail to
 *    compile if a method were missing or had the wrong signature.
 *  - `TeammateRecord` subclasses inherit the base fields and pass them
 *    through `toJson()`; the subclasses report their own `engine` kind.
 *  - The `EngineRegistry` round-trips a registered engine and rejects
 *    a duplicate-kind registration.
 *  - The default-impl verbs (`lsVerb`, `statusVerb`, `killVerb`) fall
 *    through to the empty-registry / empty-router branches with the
 *    Phase 1 wiring, producing the expected CLI surface.
 */

import { describe, expect, test } from 'vitest'

import type { Engine } from '../../src/engines/engine'
import { EngineRegistry, emptyRegistry } from '../../src/engines/registry'
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
import { ClaudeTeammateRecord } from '../../src/engines/claude/persistence'
import { decodeTmuxSessionName, tmuxSessionName } from '../../src/persistence/paths'
import { CodexTeammateRecord } from '../../src/engines/codex/persistence'
import { EmptyTeammateRouter } from '../../src/identity/router'
import { killVerb } from '../../src/verbs/kill'
import { lsVerb } from '../../src/verbs/ls'
import { statesVerb } from '../../src/verbs/states'
import { statusVerb } from '../../src/verbs/status'
import { NoopIdentityStore, type VerbContext } from '../../src/verbs/context'

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

/** Smallest possible engine — compiles iff `Engine` has the expected shape. */
class NoopEngine implements Engine {
  readonly kind: EngineKind = 'claude'
  readonly capabilities = capabilities

  async spawn(_req: SpawnRequest, _ctx: EngineContext): Promise<SpawnResult> {
    return { kind: 'spawned', name: _req.name, firstTurn: null }
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
    return { kind: 'not-supported', reason: 'noop' }
  }
  async resume(_req: ResumeRequest, _ctx: EngineContext): Promise<ResumeResult> {
    return { kind: 'not-supported', reason: 'noop' }
  }
  async last(_req: LastRequest, _ctx: EngineContext): Promise<TextResult> {
    return { kind: 'text', text: '' }
  }
  async ctx(_req: ContextRequest, _ctx: EngineContext): Promise<ContextResult> {
    return { kind: 'not-supported', reason: 'noop' }
  }
  async history(_req: HistoryRequest, _ctx: EngineContext): Promise<HistoryResult> {
    return { kind: 'not-supported', reason: 'noop' }
  }
  async mem(_req: MemoryRequest, _ctx: EngineContext): Promise<TextResult> {
    return { kind: 'not-supported', reason: 'noop' }
  }
  async reload(_req: ReloadRequest, _ctx: EngineContext): Promise<ReloadResult> {
    return { kind: 'not-supported', reason: 'noop' }
  }
  async inspect(_req: InspectRequest, _ctx: EngineContext): Promise<EngineSnapshot> {
    return { engine: this.kind, name: _req.name, fields: {} }
  }
  async doctor(_ctx: EngineContext): Promise<DoctorSection> {
    return { engine: this.kind, findings: [] }
  }
}

const ENGINE_CONTEXT: EngineContext = {
  now: () => 0,
  env: {},
}

function emptyVerbContext(): VerbContext {
  return {
    engines: emptyRegistry(),
    router: new EmptyTeammateRouter(),
    engineContext: ENGINE_CONTEXT,
    identity: new NoopIdentityStore(),
    runColumn: async (input) => ({ code: 0, stdout: input, stderr: '' }),
  }
}

describe('Engine contract — every method present', () => {
  test('a NoopEngine satisfies the Engine interface', () => {
    const engine: Engine = new NoopEngine()
    expect(engine.kind).toBe('claude')
    expect(engine.capabilities.atomicSend).toBe(true)
  })
})

describe('TeammateRecord subclasses', () => {
  test('ClaudeTeammateRecord carries the base fields and reports kind=claude', () => {
    const rec = new ClaudeTeammateRecord({
      name: 'alpha',
      repo: '/tmp/alpha',
      cwd: '/tmp/alpha',
      worktreeSlug: null,
      createdAt: 1700000000,
      displayName: 'Alpha',
    })
    expect(rec.engine).toBe('claude')
    expect(rec.name).toBe('alpha')
    expect(rec.toJson()).toEqual({
      schema: 2,
      name: 'alpha',
      engine: 'claude',
      repo: '/tmp/alpha',
      cwd: '/tmp/alpha',
      worktreeSlug: null,
      createdAt: 1700000000,
      displayName: 'Alpha',
    })
  })

  test('CodexTeammateRecord reports kind=codex with the same base shape', () => {
    const rec = new CodexTeammateRecord({
      name: 'beta',
      repo: '/tmp/beta',
      cwd: '/tmp/beta',
      worktreeSlug: null,
      createdAt: 1700000001,
      displayName: null,
    })
    expect(rec.engine).toBe('codex')
    expect(rec.toJson().engine).toBe('codex')
    expect(rec.toJson().displayName).toBeNull()
  })

  test('ClaudeTeammateRecord.engineExtensionFiles enumerates the four Phase 2a extension files', () => {
    const rec = new ClaudeTeammateRecord({
      name: 'alpha',
      repo: '/tmp/alpha',
      cwd: '/tmp/alpha',
      worktreeSlug: null,
      createdAt: 0,
      displayName: null,
    })
    expect(rec.engineExtensionFiles()).toEqual([
      '/tmp/teammate-alpha.cwd',
      '/tmp/teammate-alpha.sid',
      '/tmp/teammate-alpha.ready',
      '/tmp/teammate-alpha.send-at',
    ])
  })

  test('ClaudeTeammateRecord.tmuxSession composes the flat name without encoding', () => {
    const rec = new ClaudeTeammateRecord({
      name: 'flow-1',
      repo: '/tmp/flow',
      cwd: '/tmp/flow/.claude/worktrees/flow-1',
      worktreeSlug: 'flow-1',
      createdAt: 0,
      displayName: null,
    })
    expect(rec.tmuxSession()).toBe('teammate-flow-1')
  })

  test('tmuxSessionName / decodeTmuxSessionName round-trip flat names', () => {
    expect(tmuxSessionName('foo')).toBe('teammate-foo')
    expect(tmuxSessionName('flow-1')).toBe('teammate-flow-1')
    expect(decodeTmuxSessionName('teammate-foo')).toBe('foo')
    expect(decodeTmuxSessionName('teammate-flow-1')).toBe('flow-1')
    expect(decodeTmuxSessionName('not-a-teammate')).toBeNull()
  })
})

describe('EngineRegistry', () => {
  test('an empty registry has no kinds and no entries', () => {
    const reg = new EngineRegistry()
    expect(reg.registered()).toEqual([])
    expect(reg.kinds()).toEqual([])
    expect(reg.get('claude')).toBeUndefined()
  })

  test('registering an engine round-trips through get / registered / kinds', () => {
    const reg = new EngineRegistry()
    const engine = new NoopEngine()
    reg.register(engine)
    expect(reg.get('claude')).toBe(engine)
    expect(reg.registered()).toEqual([engine])
    expect(reg.kinds()).toEqual(['claude'])
  })

  test('re-registering the same kind throws', () => {
    const reg = new EngineRegistry()
    reg.register(new NoopEngine())
    expect(() => reg.register(new NoopEngine())).toThrow(/already registered/)
  })
})

describe('Verb-layer default impls — Phase 1 wiring', () => {
  test('lsVerb against an empty registry raises no-engine-registered', async () => {
    // A zero-engine process is a wiring failure, not a fleet state. The verb
    // must surface that loudly so a Phase 2 production process missing an
    // engine registration fails here, not later in a confused dispatcher.
    const result = await lsVerb(emptyVerbContext())
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no engine registered')
  })

  test('statesVerb against an empty registry raises no-engine-registered', async () => {
    const result = await statesVerb(emptyVerbContext())
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no engine registered')
  })

  test('statusVerb falls through to teammate-not-found with the empty router', async () => {
    const result = await statusVerb('missing', emptyVerbContext())
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no such teammate')
  })

  test('killVerb is idempotent when the registry has no claude engine fallback', async () => {
    // The empty registry has no claude engine to fall back to, so the verb
    // emits the same "not running" shape `formatKill.not-found` produces.
    // Exit code 0 keeps `tm kill <name>` script-safe before respawning.
    const result = await killVerb('missing', emptyVerbContext())
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('not running: missing')
  })
})
