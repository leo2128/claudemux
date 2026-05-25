/**
 * Contract tests for `CodexEngine`.
 *
 * The fake codex binary speaks enough app-server JSON-RPC to exercise the
 * Engine interface without an OpenAI account. Supervisor-only liveness tests
 * stay in `codex-supervisor.test.ts`; this file pins the cross-engine surface
 * Phase 2b exposes to the verb layer.
 */

import { Buffer } from 'node:buffer'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { CodexEngine } from '../src/engines/codex/engine'
import { EngineRegistry } from '../src/engines/registry'
import { ProductionTeammateRouter } from '../src/identity/router'
import {
  daemonAlive,
  readDaemonState,
  reapDaemon,
} from '../src/engines/codex/supervisor'
import {
  CodexTeammateRecord,
  codexBorrowLockFile,
  codexLastTurnFile,
  codexPidFile,
  codexStartedAtFile,
  codexTeammateDir,
  codexThreadFile,
  readBaseRecord,
  removeBaseRecord,
  writeBaseRecord,
} from '../src/engines/codex/persistence'
import { CODEX_ROLLOUT_BUSY_WINDOW_MS } from '../src/engines/codex/rollout'
import { hasCodexHistoryForCwd } from '../src/engines/codex/history'
import type { EngineContext } from '../src/engines/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_CODEX = resolve(HERE, 'fixtures', 'codex-fake', 'codex')

let registryDir: string
let identityDir: string
let cwd: string
let sessionsRoot: string
let savedRegistryRoot: string | undefined
let savedIdentityRoot: string | undefined
let savedSessionsRoot: string | undefined
let engine: CodexEngine
let spawned: string[]
let counter = 0

function ctx(): EngineContext {
  return { now: () => Date.now(), env: process.env }
}

function ctxWithEnv(env: NodeJS.ProcessEnv): EngineContext {
  return { now: () => Date.now(), env }
}

function ctxAt(nowMs: number): EngineContext {
  return { now: () => nowMs, env: process.env }
}

function nameUnder(): string {
  return `codex/engine-${counter++}`
}

beforeEach(() => {
  registryDir = mkdtempSync('/tmp/cmxe-')
  identityDir = mkdtempSync('/tmp/cmxe-id-')
  sessionsRoot = mkdtempSync('/tmp/cmxe-sessions-')
  cwd = mkdtempSync('/tmp/cmxe-cwd-')
  savedRegistryRoot = process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  savedIdentityRoot = process.env['CLAUDEMUX_IDENTITY_ROOT']
  savedSessionsRoot = process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
  process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = registryDir
  process.env['CLAUDEMUX_IDENTITY_ROOT'] = identityDir
  process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = sessionsRoot
  engine = new CodexEngine({ binPath: FAKE_CODEX, readyTimeoutMs: 5000 })
  spawned = []
})

afterEach(async () => {
  for (const name of spawned) {
    await reapDaemon(name)
    removeBaseRecord(name)
  }
  if (savedRegistryRoot === undefined) delete process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  else process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = savedRegistryRoot
  if (savedIdentityRoot === undefined) delete process.env['CLAUDEMUX_IDENTITY_ROOT']
  else process.env['CLAUDEMUX_IDENTITY_ROOT'] = savedIdentityRoot
  if (savedSessionsRoot === undefined) delete process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
  else process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = savedSessionsRoot
  rmSync(registryDir, { recursive: true, force: true })
  rmSync(identityDir, { recursive: true, force: true })
  rmSync(sessionsRoot, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function writeDaemonFiles(name: string, threadId: string): void {
  mkdirSync(codexTeammateDir(name), { recursive: true })
  writeFileSync(codexPidFile(name), `${process.pid}\n`)
  writeFileSync(codexStartedAtFile(name), '1\n')
  writeFileSync(codexThreadFile(name), `${threadId}\n`)
  writeBaseRecord(new CodexTeammateRecord({
    name,
    cwd,
    createdAt: 1,
    displayName: null,
  }))
}

function writeRollout(threadId: string, lines: readonly unknown[], mtimeMs = Date.now()): string {
  const dir = join(sessionsRoot, '2026', '05', '24')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-05-24T00-00-00-${threadId}.jsonl`)
  writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  const mtime = new Date(mtimeMs)
  utimesSync(file, mtime, mtime)
  return file
}

function codexHistoryLines(historyCwd: string, firstPrompt: string, lastAssistant: string): readonly unknown[] {
  return [
    {
      timestamp: '2026-05-24T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'session', cwd: historyCwd },
    },
    {
      timestamp: '2026-05-24T00:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: firstPrompt },
    },
    {
      timestamp: '2026-05-24T00:00:02.000Z',
      type: 'event_msg',
      payload: {
        type: 'agent_message',
        message: lastAssistant,
        phase: 'final_answer',
      },
    },
    {
      timestamp: '2026-05-24T00:00:03.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: {
            input_tokens: 12345,
            output_tokens: 321,
            total_tokens: 12666,
          },
          model_context_window: 200000,
        },
      },
    },
  ]
}

function codexHistoryResponseItemLines(
  historyCwd: string,
  firstPrompt: string,
  lastAssistant: string,
): readonly unknown[] {
  return [
    {
      timestamp: '2026-05-24T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'session', cwd: historyCwd },
    },
    {
      timestamp: '2026-05-24T00:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: firstPrompt }],
      },
    },
    {
      timestamp: '2026-05-24T00:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: lastAssistant }],
      },
    },
  ]
}

function connectionCounts(file: string): { opens: number; closes: number } {
  if (!existsSync(file)) return { opens: 0, closes: 0 }
  const lines = readFileSync(file, 'utf8').split('\n')
  return {
    opens: lines.filter((line) => line === 'open').length,
    closes: lines.filter((line) => line === 'close').length,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(predicate()).toBe(true)
}

describe('CodexEngine — core lifecycle', () => {
  test('spawn, send, list, status, wait timeout, and kill run through the Engine API', async () => {
    const name = nameUnder()
    spawned.push(name)

    const spawn = await engine.spawn(
      {
        name,
        cwd,
        resumeCheckpoint: null,
        prompt: null,
        timeoutMs: null,
        displayName: 'engine test',
      },
      ctx(),
    )
    expect(spawn).toMatchObject({ kind: 'spawned', name })
    expect(readBaseRecord(name)).toMatchObject({
      name,
      engine: 'codex',
      cwd,
      displayName: 'engine test',
    })
    const registry = new EngineRegistry()
    registry.register(engine)
    const routed = await new ProductionTeammateRouter(registry).resolve(name)
    expect(routed).toMatchObject({ name, engine })

    const send = await engine.send(
      { name, prompt: 'pong from codex', timeoutMs: 5000, paneQuiet: false },
      ctx(),
    )
    expect(send.kind).toBe('completed')
    if (send.kind === 'completed') {
      expect(send.text).toBe('fake reply: pong from codex\n')
      expect(send.items).toContainEqual({ kind: 'assistant-text', text: 'fake reply: pong from codex' })
      expect(send.tmResult?.stdout).toBe('fake reply: pong from codex\n')
      expect(send.tmResult?.stderr).toContain(`sent to ${name} (codex)\n`)
      expect(send.tmResult?.stderr).toContain('sid=thread-1\n')
      expect(send.tmResult?.stderr).toContain('ctx: 1234 tokens · 0% of 200k\n')
      expect(send.tmResult?.stderr).toContain(`raw: ${codexLastTurnFile(name)}\n`)
    }
    const rawLastTurn = JSON.parse(readFileSync(codexLastTurnFile(name), 'utf8')) as Record<string, unknown>
    expect(rawLastTurn['threadId']).toBe('thread-1')
    const rawLast = await engine.last({ name, verbose: true }, ctx())
    expect(rawLast).toMatchObject({ kind: 'text' })
    if (rawLast.kind === 'text') {
      expect(JSON.parse(rawLast.text)['threadId']).toBe('thread-1')
    }

    const listing = await engine.list(ctx())
    expect(listing.map((row) => row.name)).toContain(name)
    const row = listing.find((candidate) => candidate.name === name)
    expect(row?.extras).toMatchObject({
      sidShort: 'thread-1',
      busy: 'no',
      last: '-',
      preview: '-',
    })
    writeFileSync(codexBorrowLockFile(name), `${process.pid}\n`)
    const busyRow = (await engine.list(ctx())).find((candidate) => candidate.name === name)
    expect(busyRow).toMatchObject({ state: 'busy', extras: { busy: 'yes' } })

    const status = await engine.status({ name, lines: null }, ctx())
    expect(status).toMatchObject({ kind: 'present', name, engine: 'codex', state: 'busy', cwd })
    if (status.kind === 'present') {
      expect(status.pane).toContain(`codex: ${name}`)
      expect(status.pane).toContain('socket reachable: yes')
      expect(status.diagnostics['socketReachable']).toBe('yes')
    }
    rmSync(codexBorrowLockFile(name), { force: true })

    const wait = await engine.wait(
      { name, recoverFor: null, timeoutMs: 10, fresh: false, paneQuiet: false },
      ctx(),
    )
    expect(wait).toMatchObject({ kind: 'timed-out' })

    const killed = await engine.kill({ name }, ctx())
    expect(killed).toEqual({ kind: 'killed' })
    expect(await engine.status({ name, lines: null }, ctx())).toEqual({ kind: 'not-found' })
  })

  test('duplicate spawn is rejected while the daemon is alive', async () => {
    const name = nameUnder()
    spawned.push(name)
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      ctx(),
    )

    const duplicate = await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      ctx(),
    )
    expect(duplicate).toEqual({ kind: 'already-exists', existingEngine: 'codex' })
  })

  test('resume starts a daemon, writes the thread id, and calls thread/resume', async () => {
    const name = nameUnder()
    const threadId = '019e5f5f-2e57-7abc-8def-123456789abc'
    const rpcLog = join(registryDir, 'resume-rpc.log')
    spawned.push(name)

    const resumed = await engine.resume(
      {
        name,
        cwd,
        checkpoint: threadId,
        prompt: null,
        displayName: 'resumed codex',
      },
      ctxWithEnv({ ...process.env, CODEX_FAKE_RPC_LOG: rpcLog }),
    )

    expect(resumed).toMatchObject({
      kind: 'resumed',
      checkpoint: threadId,
      tmResult: {
        code: 0,
        stdout: `resumed: ${threadId}\n`,
        stderr: expect.stringMatching(new RegExp(`^resumed: ${name} \\(pid=\\d+, socket=.*\\)\\n$`)),
      },
    })
    expect(readBaseRecord(name)).toMatchObject({
      name,
      engine: 'codex',
      cwd,
      displayName: 'resumed codex',
    })
    expect(readDaemonState(name)?.threadId).toBe(threadId)
    expect(readFileSync(codexThreadFile(name), 'utf8').trim()).toBe(threadId)
    expect(readFileSync(rpcLog, 'utf8').split('\n')).toContain('thread/resume')

    const send = await engine.send(
      { name, prompt: 'continue from resumed thread', timeoutMs: 5000, paneQuiet: false },
      ctx(),
    )
    expect(send).toMatchObject({ kind: 'completed' })
    expect(readDaemonState(name)?.threadId).toBe(threadId)
  })

  test('resume without a thread id lists the latest codex thread for the cwd', async () => {
    const name = nameUnder()
    const threadId = '019e5f5f-2e57-7abc-8def-123456789ac6'
    const rpcLog = join(registryDir, 'resume-latest-rpc.log')
    spawned.push(name)

    const resumed = await engine.resume(
      {
        name,
        cwd,
        checkpoint: null,
        prompt: null,
        displayName: 'latest codex',
      },
      ctxWithEnv({
        ...process.env,
        CODEX_FAKE_RPC_LOG: rpcLog,
        CODEX_FAKE_THREAD_LIST_ID: threadId,
      }),
    )

    expect(resumed).toMatchObject({
      kind: 'resumed',
      checkpoint: threadId,
      tmResult: {
        code: 0,
        stdout: `resumed: ${threadId}\n`,
      },
    })
    expect(readBaseRecord(name)).toMatchObject({
      name,
      engine: 'codex',
      cwd,
      displayName: 'latest codex',
    })
    expect(readDaemonState(name)?.threadId).toBe(threadId)
    const methods = readFileSync(rpcLog, 'utf8').trim().split('\n')
    expect(methods).toContain('thread/list')
    expect(methods).toContain('thread/resume')
    expect(methods.indexOf('thread/list')).toBeLessThan(methods.indexOf('thread/resume'))
  })

  test('resume without a thread id reports not-found when codex has no cwd history', async () => {
    const name = nameUnder()

    const resumed = await engine.resume(
      {
        name,
        cwd,
        checkpoint: null,
        prompt: null,
        displayName: null,
      },
      ctxWithEnv({ ...process.env, CODEX_FAKE_THREAD_LIST_EMPTY: '1' }),
    )

    expect(resumed).toEqual({
      kind: 'not-found',
      reason: `no codex threads found for cwd ${cwd}`,
    })
    expect(readBaseRecord(name)).toBeNull()
    expect(readDaemonState(name)).toBeNull()
  })

  test('resume rejects an already running codex teammate', async () => {
    const name = nameUnder()
    spawned.push(name)
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      ctx(),
    )

    const resumed = await engine.resume(
      {
        name,
        cwd,
        checkpoint: '019e5f5f-2e57-7abc-8def-123456789abc',
        prompt: null,
        displayName: null,
      },
      ctx(),
    )

    expect(resumed).toEqual({
      kind: 'failed',
      message: `codex teammate '${name}' is already running`,
    })
  })

  test('resume accepts UUIDv7-shaped thread ids but rejects non-UUID checkpoints', async () => {
    const acceptedName = nameUnder()
    const threadId = '019e5f5f-2e57-7abc-8def-123456789abc'
    spawned.push(acceptedName)

    const accepted = await engine.resume(
      {
        name: acceptedName,
        cwd,
        checkpoint: threadId,
        prompt: null,
        displayName: null,
      },
      ctx(),
    )
    expect(accepted).toMatchObject({ kind: 'resumed', checkpoint: threadId })

    const rejectedName = nameUnder()
    const rejected = await engine.resume(
      {
        name: rejectedName,
        cwd,
        checkpoint: 'not-a-thread-id',
        prompt: null,
        displayName: null,
      },
      ctx(),
    )
    expect(rejected).toEqual({
      kind: 'failed',
      message: 'codex thread id is not a valid uuid: not-a-thread-id',
    })
    expect(readBaseRecord(rejectedName)).toBeNull()
    expect(readDaemonState(rejectedName)).toBeNull()

    // A partial thread id pasted from `tm history` is the common shape of
    // the "wrong-id" error in practice; surface the actionable hint
    // instead of the bare "not a valid uuid" line.
    const prefixName = nameUnder()
    const prefixRejected = await engine.resume(
      {
        name: prefixName,
        cwd,
        checkpoint: '019e5f5f',
        prompt: null,
        displayName: null,
      },
      ctx(),
    )
    expect(prefixRejected).toEqual({
      kind: 'failed',
      message:
        `received '019e5f5f', looks like a thread-id prefix; resume ` +
        `requires the full thread id. Run 'tm history ${prefixName} 019e5f5f' to ` +
        `expand it, or 'tm history ${prefixName}' to list past threads with full ids.`,
    })
    expect(readBaseRecord(prefixName)).toBeNull()
    expect(readDaemonState(prefixName)).toBeNull()
  })

  test('concurrent same-name spawn keeps the winning daemon alive', async () => {
    const name = nameUnder()
    spawned.push(name)
    const slowCtx = ctxWithEnv({ ...process.env, CODEX_FAKE_BIND_DELAY_MS: '250' })

    const [first, second] = await Promise.all([
      engine.spawn(
        { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
        slowCtx,
      ),
      engine.spawn(
        { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
        slowCtx,
      ),
    ])

    const results = [first, second]
    expect(results.filter((result) => result.kind === 'spawned')).toHaveLength(1)
    const loser = results.find((result) => result.kind === 'already-exists')
    expect(loser).toEqual({ kind: 'already-exists', existingEngine: 'codex' })
    expect(daemonAlive(name)).toBe(true)
    expect(await engine.status({ name, lines: null }, ctx())).toMatchObject({
      kind: 'present',
      name,
      engine: 'codex',
    })
  })

  test('last and ctx read the persisted codex rollout for the current thread', async () => {
    const name = nameUnder()
    const threadId = '019e-rollout-last'
    writeDaemonFiles(name, threadId)
    const rollout = writeRollout(threadId, [
      {
        timestamp: '2026-05-24T00:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'intermediate note',
          phase: 'commentary',
          memory_citation: null,
        },
      },
      {
        timestamp: '2026-05-24T00:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'final answer from rollout' }],
        },
      },
      {
        timestamp: '2026-05-24T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'agentMessage',
          text: 'camel agent message from rollout',
          phase: 'final_answer',
        },
      },
      {
        timestamp: '2026-05-24T00:00:04.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 12345,
              cached_input_tokens: 10000,
              output_tokens: 321,
              reasoning_output_tokens: 111,
              total_tokens: 12666,
            },
            model_context_window: 200000,
          },
        },
      },
    ])

    const last = await engine.last({ name, verbose: false }, ctx())
    expect(last).toEqual({ kind: 'text', text: 'camel agent message from rollout\n' })

    const context = await engine.ctx({ name, windowOverride: '' }, ctx())
    expect(context).toEqual({
      kind: 'usage',
      tokensUsed: 12666,
      tokensTotal: 200000,
      pct: 6,
    })

    const status = await engine.status({ name, lines: null }, ctx())
    expect(status).toMatchObject({
      kind: 'present',
      diagnostics: { thread: threadId, rollout },
    })
  })

  test('last reports not-found when the persisted thread has no rollout file', async () => {
    const name = nameUnder()
    writeDaemonFiles(name, '019e-missing-rollout')

    const last = await engine.last({ name, verbose: false }, ctx())

    expect(last).toMatchObject({
      kind: 'not-found',
      reason: expect.stringContaining("rollout for thread '019e-missing-rollout' not found"),
    })
  })

  test('list treats recent rollout writes as busy when RPC thread status is unavailable', async () => {
    const name = nameUnder()
    spawned.push(name)
    const nowMs = 1_800_000_000_000
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      ctx(),
    )
    await engine.send(
      { name, prompt: 'seed a thread', timeoutMs: 5000, paneQuiet: false },
      ctx(),
    )
    const threadId = readDaemonState(name)?.threadId
    expect(threadId).toBeTypeOf('string')

    writeRollout(threadId!, [], nowMs - 5_000)
    const busy = (await engine.list({ now: () => nowMs, env: process.env }))
      .find((row) => row.name === name)
    expect(busy).toMatchObject({ state: 'busy', extras: { busy: 'yes' } })

    writeRollout(threadId!, [], nowMs - CODEX_ROLLOUT_BUSY_WINDOW_MS - 1_000)
    const idle = (await engine.list({ now: () => nowMs, env: process.env }))
      .find((row) => row.name === name)
    expect(idle).toMatchObject({ state: 'idle', extras: { busy: 'no' } })
  })

  test('list renders states LAST and PREVIEW from codex rollout last assistant text', async () => {
    const name = nameUnder()
    const threadId = '019e5f5f-2e57-7abc-8def-123456789ac5'
    const nowMs = 1_800_000_000_000
    const assistantAtMs = nowMs - 45_000
    const lastAssistant =
      `abcdefghijklmnopqrstuvwxyz${String.fromCharCode(7)}ABCDEFGHIJKLMNOPQRSTUVWXYZ-extra\nsecond line`
    writeDaemonFiles(name, threadId)
    writeRollout(
      threadId,
      [
        {
          timestamp: new Date(assistantAtMs).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'agent_message',
            message: lastAssistant,
            phase: 'final_answer',
          },
        },
        {
          timestamp: new Date(nowMs - 10_000).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 10 },
              model_context_window: 100,
            },
          },
        },
      ],
      nowMs - 10_000,
    )

    const row = (await engine.list({ now: () => nowMs, env: process.env }))
      .find((candidate) => candidate.name === name)

    expect(row).toMatchObject({
      extras: {
        last: `${Buffer.byteLength(lastAssistant, 'utf8')}B/45s`,
        preview: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWX',
      },
    })
    expect(row?.extras['preview']).not.toContain('pid=')
  })

  test('list keeps busy when RPC thread status is idle but the rollout is fresh', async () => {
    const name = nameUnder()
    spawned.push(name)
    const nowMs = 1_800_000_000_000
    const threadReadCtx = ctxWithEnv({ ...process.env, CODEX_FAKE_THREAD_READ_STATUS: 'idle' })
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      threadReadCtx,
    )
    await engine.send(
      { name, prompt: 'seed a thread', timeoutMs: 5000, paneQuiet: false },
      ctx(),
    )
    const threadId = readDaemonState(name)?.threadId
    expect(threadId).toBeTypeOf('string')

    writeRollout(threadId!, [], nowMs - 5_000)
    const busy = (await engine.list({ now: () => nowMs, env: process.env }))
      .find((row) => row.name === name)
    expect(busy).toMatchObject({
      state: 'busy',
      extras: { busy: 'yes', threadStatus: 'idle' },
    })

    writeRollout(threadId!, [], nowMs - CODEX_ROLLOUT_BUSY_WINDOW_MS - 1_000)
    const idle = (await engine.list({ now: () => nowMs, env: process.env }))
      .find((row) => row.name === name)
    expect(idle).toMatchObject({
      state: 'idle',
      extras: { busy: 'no', threadStatus: 'idle' },
    })
  })

  test('status closes a runtime-probe client that initializes after the timeout', async () => {
    const name = nameUnder()
    spawned.push(name)
    const connectionLog = join(registryDir, 'connections.log')
    const slowInitializeCtx = ctxWithEnv({
      ...process.env,
      CODEX_FAKE_CONNECTION_LOG: connectionLog,
      CODEX_FAKE_INITIALIZE_DELAY_MS: '400',
    })
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      slowInitializeCtx,
    )
    await waitFor(() => connectionCounts(connectionLog).closes >= 1)
    const before = connectionCounts(connectionLog)

    const status = await engine.status({ name, lines: null }, ctx())

    expect(status).toMatchObject({
      kind: 'present',
      diagnostics: { socketReachable: 'no' },
    })
    await waitFor(() => connectionCounts(connectionLog).closes >= before.closes + 1)
    const after = connectionCounts(connectionLog)
    expect(after.opens).toBe(after.closes)
  })

  test('history list reads codex rollouts for the teammate cwd', async () => {
    const name = nameUnder()
    const activeThreadId = '019e5f5f-2e57-7abc-8def-123456789abc'
    const oldThreadId = '019e5f5f-2e57-7abc-8def-123456789abd'
    const otherThreadId = '019e5f5f-2e57-7abc-8def-123456789abe'
    const otherCwd = mkdtempSync('/tmp/cmxe-other-cwd-')
    const nowMs = 1_800_000_000_000
    writeDaemonFiles(name, activeThreadId)
    writeRollout(
      activeThreadId,
      codexHistoryLines(cwd, 'Implement codex history', 'active answer'),
      nowMs - 5_000,
    )
    writeRollout(
      oldThreadId,
      codexHistoryLines(cwd, 'Older codex thread', 'old answer'),
      nowMs - 70_000,
    )
    writeRollout(
      otherThreadId,
      codexHistoryLines(otherCwd, 'Other repo thread', 'other answer'),
      nowMs - 1_000,
    )

    try {
      const result = await engine.history({ name, cwd, index: null }, ctxAt(nowMs))

      expect(result.kind).toBe('list')
      expect(result.tmResult?.code).toBe(0)
      expect(result.tmResult?.stdout).toContain('ENGINE')
      // List mode now renders the full thread id (was the 8-char prefix);
      // pin against `activeThreadId` so the test tracks the contract `tm
      // resume` accepts rather than a now-defunct truncation.
      expect(result.tmResult?.stdout).toContain(`*  codex   ${activeThreadId}  5s`)
      expect(result.tmResult?.stdout).toContain('Implement codex history')
      expect(result.tmResult?.stdout).toContain('Older codex thread')
      expect(result.tmResult?.stdout).not.toContain('Other repo thread')
    } finally {
      rmSync(otherCwd, { recursive: true, force: true })
    }
  })

  test('history detail expands a codex thread id prefix', async () => {
    const name = nameUnder()
    const threadId = '019e5f5f-2e57-7abc-8def-123456789abf'
    const nowMs = 1_800_000_000_000
    const rollout = writeRollout(
      threadId,
      codexHistoryLines(cwd, 'Resume this codex thread', 'last codex assistant text'),
      nowMs - 125_000,
    )

    const result = await engine.history({ name, cwd, index: threadId.slice(0, 8) }, ctxAt(nowMs))

    expect(result.kind).toBe('detail')
    expect(result.tmResult?.code).toBe(0)
    expect(result.tmResult?.stdout).toContain(`thread:     ${threadId}`)
    expect(result.tmResult?.stdout).toContain(`rollout:    ${rollout}`)
    expect(result.tmResult?.stdout).toContain('created:    2026-05-24 00:00:00')
    expect(result.tmResult?.stdout).toContain('ctx:        12666 tokens · 6% of 200k')
    expect(result.tmResult?.stdout).toContain('Resume this codex thread')
    expect(result.tmResult?.stdout).toContain('last codex assistant text')
    expect(result.tmResult?.stdout).toContain(`resume: tm resume ${name} ${threadId}`)
  })

  test('history detail rejects an invalid codex thread prefix', async () => {
    const result = await engine.history({ name: nameUnder(), cwd, index: 'XYZ-not-hex' }, ctx())

    expect(result.kind).toBe('failed')
    expect(result.tmResult).toEqual({
      code: 1,
      stdout: '',
      stderr: "tm: history: invalid thread-id prefix 'XYZ-not-hex'\n",
    })
  })

  test('history detail asks for a longer prefix when multiple codex threads match', async () => {
    const name = nameUnder()
    const firstThreadId = '019e5f5f-1111-7abc-8def-123456789abc'
    const secondThreadId = '019e5f5f-2222-7abc-8def-123456789abc'
    writeRollout(firstThreadId, codexHistoryLines(cwd, 'First match', 'first answer'))
    writeRollout(secondThreadId, codexHistoryLines(cwd, 'Second match', 'second answer'))

    const result = await engine.history({ name, cwd, index: '019e5f5f' }, ctx())

    expect(result.kind).toBe('failed')
    expect(result.tmResult?.stderr).toContain("prefix '019e5f5f' matches 2 codex threads")
    expect(result.tmResult?.stderr).toContain(firstThreadId)
    expect(result.tmResult?.stderr).toContain(secondThreadId)
  })

  test('history falls back to response_item user text when event_msg user text is absent', async () => {
    const name = nameUnder()
    const threadId = '019e5f5f-2e57-7abc-8def-123456789ac2'
    writeRollout(
      threadId,
      codexHistoryResponseItemLines(cwd, 'Prompt from response item', 'assistant response item'),
    )

    const list = await engine.history({ name, cwd, index: null }, ctx())
    expect(list.kind).toBe('list')
    expect(list.tmResult?.stdout).toContain('Prompt from response item')

    const detail = await engine.history({ name, cwd, index: threadId.slice(0, 8) }, ctx())
    expect(detail.kind).toBe('detail')
    expect(detail.tmResult?.stdout).toContain('Prompt from response item')
    expect(detail.tmResult?.stdout).toContain('assistant response item')
  })

  test('history list returns an empty codex-thread line when no rollout matches the cwd', async () => {
    const name = nameUnder()

    const result = await engine.history({ name, cwd, index: null }, ctx())

    expect(result.kind).toBe('list')
    expect(result.tmResult).toEqual({
      code: 0,
      stdout: `(no codex threads for ${name})\n`,
      stderr: '',
    })
  })

  test('history routing detects cwd from only the rollout session_meta line', () => {
    const threadId = '019e5f5f-2e57-7abc-8def-123456789ac3'
    const rollout = writeRollout(threadId, [
      {
        timestamp: '2026-05-24T00:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'session', cwd },
      },
    ])
    writeFileSync(rollout, `${readFileSync(rollout, 'utf8')}${'x'.repeat(128 * 1024)}\n`)

    expect(hasCodexHistoryForCwd(cwd, process.env)).toBe(true)
  })

  test('history list marks the live codex thread', async () => {
    const name = nameUnder()
    const liveThreadId = '019e5f5f-2e57-7abc-8def-123456789ac0'
    const nowMs = 1_800_000_000_000
    writeDaemonFiles(name, liveThreadId)
    writeRollout(
      liveThreadId,
      codexHistoryLines(cwd, 'Live codex topic', 'live answer'),
      nowMs - 10_000,
    )

    const result = await engine.history({ name, cwd, index: null }, ctxAt(nowMs))

    expect(result.kind).toBe('list')
    expect(result.tmResult?.stdout).toMatch(/^\*  codex\s+019e5f5f/m)
  })

  test('doctor reaps a crashed daemon registry entry', async () => {
    const name = nameUnder()
    spawned.push(name)
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      ctx(),
    )
    const state = readDaemonState(name)
    expect(state).not.toBeNull()
    process.kill(state!.pid, 'SIGKILL')
    await new Promise((res) => setTimeout(res, 100))

    const report = await engine.doctor(ctx())
    expect(report.findings.some((finding) => finding.summary.includes(name))).toBe(true)
    expect(readDaemonState(name)).toBeNull()
    expect(readBaseRecord(name)).toBeNull()
  })

  test('wait recovers a turn that completed in the send-timeout-to-wait window via thread/read backfill', { timeout: 15000 }, async () => {
    // End-to-end pin for the Codex side of the 124 contract. The send →
    // 124 → wait flow used to silently drop the in-window completion
    // (the new wait subscription only sees events AFTER it attaches);
    // backfill via `thread/read(includeTurns: true)` now closes that gap.
    //
    // The fake codex re-reads the backfill JSON from BACKFILL_FILE on
    // every `thread/read`, so the test can stage the file AFTER the
    // daemon has spawned (env is frozen at fork) but before issuing the
    // wait. CODEX_FAKE_THREAD_READ_STATUS must also be set so the fake
    // routes thread/read into the backfill branch — both env vars must
    // be present at daemon spawn time.
    const name = nameUnder()
    spawned.push(name)
    const backfillFile = join(registryDir, `${counter}-backfill.json`)
    const savedStatus = process.env['CODEX_FAKE_THREAD_READ_STATUS']
    const savedBackfillFile = process.env['CODEX_FAKE_THREAD_READ_BACKFILL_FILE']
    process.env['CODEX_FAKE_THREAD_READ_STATUS'] = 'idle'
    process.env['CODEX_FAKE_THREAD_READ_BACKFILL_FILE'] = backfillFile
    // A fresh CodexEngine pins the env-at-spawn the daemon will see.
    const localEngine = new CodexEngine({ binPath: FAKE_CODEX, readyTimeoutMs: 5000 })
    try {
      await localEngine.spawn(
        {
          name,
          cwd,
          resumeCheckpoint: null,
          prompt: null,
          timeoutMs: null,
          displayName: 'wait backfill',
        },
        ctx(),
      )
      // Seed a thread id so `wait` doesn't bail with the "no started thread" error.
      const send = await localEngine.send(
        { name, prompt: 'kickoff', timeoutMs: 5000, paneQuiet: false },
        ctx(),
      )
      expect(send.kind).toBe('completed')
      const threadId = readDaemonState(name)?.threadId
      expect(threadId).toBeTruthy()

      const backfillTurn = {
        id: 'turn-backfilled',
        items: [
          {
            type: 'agentMessage',
            id: 'msg-backfilled',
            text: 'fake reply: backfilled',
            phase: null,
            memoryCitation: null,
          },
        ],
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: 1,
        // `completedAt` must beat the daemon's `lastSeen` — the previous
        // `engine.send` just touched it to `nowSec()`. Push the backfill
        // a few seconds into the future so the picker accepts it.
        completedAt: Math.floor(Date.now() / 1000) + 60,
        durationMs: 1,
      }
      writeFileSync(backfillFile, JSON.stringify([backfillTurn]))

      // `--timeout` is short — the live subscription would never fire
      // (no `turn/start` triggers it). Only the read backfill can
      // resolve this wait. If it does NOT resolve, the verb times out
      // → kind === 'timed-out', which is the regression we are pinning
      // against.
      const wait = await localEngine.wait(
        { name, recoverFor: null, timeoutMs: 5000, fresh: false, paneQuiet: false },
        ctx(),
      )
      expect(wait.kind).toBe('completed')
      if (wait.kind === 'completed') {
        expect(wait.text).toBe('fake reply: backfilled\n')
        expect(wait.tmResult?.stderr).toContain(`waited on ${name} (codex)\n`)
      }
      const raw = JSON.parse(readFileSync(codexLastTurnFile(name), 'utf8')) as {
        turn?: { id?: unknown }
      }
      expect(raw.turn?.id).toBe('turn-backfilled')
    } finally {
      if (savedStatus === undefined) delete process.env['CODEX_FAKE_THREAD_READ_STATUS']
      else process.env['CODEX_FAKE_THREAD_READ_STATUS'] = savedStatus
      if (savedBackfillFile === undefined) delete process.env['CODEX_FAKE_THREAD_READ_BACKFILL_FILE']
      else process.env['CODEX_FAKE_THREAD_READ_BACKFILL_FILE'] = savedBackfillFile
      rmSync(backfillFile, { force: true })
    }
  })

  /**
   * Stage a wait-backfill scenario against the fake daemon: spawn a
   * Codex teammate with `CODEX_FAKE_THREAD_READ_*` set at fork, seed a
   * thread id via a real `engine.send`, then write the backfill JSON to
   * disk for the next `thread/read` to pick up. Returns the wait result
   * so each test asserts the status-specific outcome.
   *
   * Hoisted out of the happy-path test to keep the failed/interrupted
   * variants from re-stating ~50 lines of identical scaffold; the
   * shared driver is also the single site any future fake-daemon
   * change has to update.
   */
  async function runWaitBackfillScenario(turnStatus: 'completed' | 'failed' | 'interrupted', extraTurnFields: Partial<Record<string, unknown>> = {}) {
    const name = nameUnder()
    spawned.push(name)
    const backfillFile = join(registryDir, `${counter}-backfill.json`)
    const savedStatus = process.env['CODEX_FAKE_THREAD_READ_STATUS']
    const savedBackfillFile = process.env['CODEX_FAKE_THREAD_READ_BACKFILL_FILE']
    process.env['CODEX_FAKE_THREAD_READ_STATUS'] = 'idle'
    process.env['CODEX_FAKE_THREAD_READ_BACKFILL_FILE'] = backfillFile
    const localEngine = new CodexEngine({ binPath: FAKE_CODEX, readyTimeoutMs: 5000 })
    try {
      await localEngine.spawn(
        { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: `wait backfill ${turnStatus}` },
        ctx(),
      )
      const send = await localEngine.send(
        { name, prompt: 'kickoff', timeoutMs: 5000, paneQuiet: false },
        ctx(),
      )
      expect(send.kind).toBe('completed')

      const backfillTurn = {
        id: `turn-backfilled-${turnStatus}`,
        items: [],
        itemsView: 'notLoaded',
        status: turnStatus,
        // turnNotificationToResult reads error.message for failed turns;
        // null is fine for completed/interrupted.
        error: null,
        startedAt: 1,
        completedAt: Math.floor(Date.now() / 1000) + 60,
        durationMs: 1,
        ...extraTurnFields,
      }
      writeFileSync(backfillFile, JSON.stringify([backfillTurn]))

      return await localEngine.wait(
        { name, recoverFor: null, timeoutMs: 5000, fresh: false, paneQuiet: false },
        ctx(),
      )
    } finally {
      if (savedStatus === undefined) delete process.env['CODEX_FAKE_THREAD_READ_STATUS']
      else process.env['CODEX_FAKE_THREAD_READ_STATUS'] = savedStatus
      if (savedBackfillFile === undefined) delete process.env['CODEX_FAKE_THREAD_READ_BACKFILL_FILE']
      else process.env['CODEX_FAKE_THREAD_READ_BACKFILL_FILE'] = savedBackfillFile
      rmSync(backfillFile, { force: true })
    }
  }

  test('wait backfill surfaces a late `failed` terminal turn — review-71 P1-3 gap', { timeout: 15000 }, async () => {
    // Counterpart to the happy-path backfill test: a turn that failed
    // in the [send-timeout, wait-subscribe] window must reach the
    // dispatcher as exit 1 (kind: 'failed') instead of spinning to 124
    // on a thread that already settled into an error. The shared
    // `turnNotificationToResult` site is what guarantees this maps the
    // same way a live notification would.
    const wait = await runWaitBackfillScenario('failed', {
      error: { message: 'fake backfilled failure' },
    })
    expect(wait.kind).toBe('failed')
    if (wait.kind === 'failed') {
      expect(wait.message).toContain('fake backfilled failure')
    }
  })

  test('wait backfill surfaces a late `interrupted` terminal turn — review-71 P1-3 gap', { timeout: 15000 }, async () => {
    // Same shape as the failed test; `interrupted` maps to a recoverable
    // failed TurnResult by `turnNotificationToResult`. The dispatcher
    // still sees exit 1 with a distinct stderr message, never 124.
    const wait = await runWaitBackfillScenario('interrupted')
    expect(wait.kind).toBe('failed')
    if (wait.kind === 'failed') {
      expect(wait.message).toContain('interrupted')
    }
  })
})
