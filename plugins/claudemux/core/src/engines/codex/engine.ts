/**
 * Codex Engine implementation.
 *
 * This is the Phase 2b migration target for the former root-level
 * `codex-verbs.ts` logic. Codex keeps its JSON-RPC notification stream,
 * daemon supervision, and `/tmp/teammate-codex/<name>/` registry private to
 * this directory; the public surface is the shared `Engine` interface.
 */

import type { Engine } from '../engine'
import type {
  CompactRequest,
  CompactResult,
  DoctorFinding,
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
  InteractionItem,
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
} from '../types'
import type { ClientInfo, InitializeResponse } from '../../codex-protocol/index.js'
import type { ThreadItem } from '../../codex-protocol/v2/ThreadItem.js'
import type { ThreadResumeResponse } from '../../codex-protocol/v2/ThreadResumeResponse.js'
import type { ThreadStartResponse } from '../../codex-protocol/v2/ThreadStartResponse.js'
import type { TurnCompletedNotification } from './events.js'
import { CodexWsClient } from './rpc.js'
import { runTurn, subscribeTurnCollection } from './events.js'
import {
  CodexDaemonAlreadyAliveError,
  CodexDaemonSpawnInProgressError,
  daemonBorrowed,
  daemonAlive,
  isProcessAlive,
  listDaemons,
  readDaemonState,
  reapDaemon,
  spawnDaemon,
  touchLastSeen,
  writeThreadId,
} from './supervisor.js'
import {
  CodexTeammateRecord,
  readBaseRecord,
  readCodexMeta,
  removeBaseRecord,
  writeBaseRecord,
} from './persistence.js'

export const CODEX_CLIENT_INFO: ClientInfo = {
  name: 'claudemux',
  title: null,
  version: '1.0.0-beta.0',
}

const COMPACT_REASON =
  'codex compacts its own context automatically when the 252k window fills'

export interface CodexEngineOptions {
  readonly binPath?: string
  readonly readyTimeoutMs?: number
}

function notSupported(reason: string): TextResult {
  return { kind: 'not-supported', reason }
}

function itemToInteractions(item: ThreadItem): readonly InteractionItem[] {
  if (item.type === 'agentMessage') {
    return [{ kind: 'assistant-text', text: item.text }]
  }
  if (item.type === 'commandExecution') {
    return [
      { kind: 'tool-call', tool: 'commandExecution', argsJson: item.command },
      {
        kind: 'tool-result',
        tool: 'commandExecution',
        ok: item.exitCode === 0,
        textOrJson: item.aggregatedOutput ?? '',
      },
    ]
  }
  if (item.type === 'mcpToolCall') {
    return [
      { kind: 'tool-call', tool: item.tool, argsJson: JSON.stringify(item.arguments) },
      {
        kind: 'tool-result',
        tool: item.tool,
        ok: item.error === null,
        textOrJson: JSON.stringify(item.result ?? item.error ?? null),
      },
    ]
  }
  return [{ kind: 'system-note', text: JSON.stringify(item) }]
}

export function turnNotificationToResult(completed: TurnCompletedNotification): TurnResult {
  const text = `${JSON.stringify(completed, null, 2)}\n`
  const items = completed.turn.items.flatMap((item) => itemToInteractions(item))
  if (completed.turn.status === 'failed') {
    return {
      kind: 'failed',
      message: completed.turn.error?.message ?? 'codex turn failed',
      recoverable: false,
    }
  }
  if (completed.turn.status === 'interrupted') {
    return {
      kind: 'failed',
      message: 'codex turn was interrupted',
      recoverable: true,
    }
  }
  return { kind: 'completed', text, items, context: null }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number | null,
): Promise<T | { timedOut: true }> {
  if (timeoutMs === null) return promise
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      promise,
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

function isTimedOut<T>(value: T | { timedOut: true }): value is { timedOut: true } {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { timedOut?: unknown }).timedOut === true
  )
}

function fmtAge(age: number): string {
  if (age < 60) return `${age}s`
  if (age < 3600) return `${Math.floor(age / 60)}m`
  if (age < 86400) return `${Math.floor(age / 3600)}h`
  return `${Math.floor(age / 86400)}d`
}

function codexDaemonState(
  name: string,
  state: ReturnType<typeof readDaemonState> = readDaemonState(name),
): 'idle' | 'busy' | 'unknown' {
  if (state === null || !isProcessAlive(state.pid)) return 'unknown'
  return daemonBorrowed(name) ? 'busy' : 'idle'
}

function codexListExtras(
  name: string,
  nowSec: number,
  state: ReturnType<typeof readDaemonState>,
): Readonly<Record<string, string>> {
  const pid = state?.pid === undefined ? '' : String(state.pid)
  const thread = state?.threadId ?? ''
  const daemonState = codexDaemonState(name, state)
  const lastSeen =
    state?.lastSeen === null || state?.lastSeen === undefined ? '' : String(state.lastSeen)
  const lastSeenAge =
    state?.lastSeen === null || state?.lastSeen === undefined
      ? '-'
      : fmtAge(Math.max(0, nowSec - state.lastSeen))
  return {
    sidShort: thread.length === 0 ? 'codex' : thread.slice(0, 8),
    busy: daemonState === 'busy' ? 'yes' : daemonState === 'idle' ? 'no' : '?',
    last: lastSeenAge,
    preview: pid.length === 0 ? 'codex daemon' : `pid=${pid}`,
    pid,
    socket: state?.socketPath ?? '',
    thread,
    lastSeen,
  }
}

export class CodexEngine implements Engine {
  readonly kind: EngineKind = 'codex'
  readonly capabilities: EngineCapabilities = {
    atomicSend: true,
    atomicSpawnPrompt: true,
    compaction: 'auto',
    contextUsage: 'rpc-token-usage',
    history: 'unsupported',
    memory: 'unsupported',
    reload: 'unsupported',
    resume: 'unsupported',
    detachedTurn: 'unsupported',
    events: 'push',
  }

  constructor(private readonly options: CodexEngineOptions = {}) {}

  async spawn(req: SpawnRequest, ctx: EngineContext): Promise<SpawnResult> {
    const existing = readBaseRecord(req.name)
    if (existing !== null) {
      if (existing.engine !== 'codex') return { kind: 'already-exists', existingEngine: existing.engine }
      if (daemonAlive(req.name)) return { kind: 'already-exists', existingEngine: 'codex' }
      removeBaseRecord(req.name)
    }
    if (daemonAlive(req.name)) return { kind: 'already-exists', existingEngine: 'codex' }

    const createdAt = Math.floor(ctx.now() / 1000)
    const record = new CodexTeammateRecord({
      name: req.name,
      cwd: req.cwd,
      createdAt,
      displayName: req.displayName,
    })

    try {
      await spawnDaemon({
        name: req.name,
        binPath: this.options.binPath,
        cwd: req.cwd,
        env: ctx.env,
        readyTimeoutMs: this.options.readyTimeoutMs,
        meta: {
          schema: 1,
          name: req.name,
          cwd: req.cwd,
          displayName: req.displayName,
          spawnedAt: createdAt,
        },
      })

      await this.healthCheck(req.name)
      writeBaseRecord(record)

      if (req.prompt === null) {
        return { kind: 'spawned', name: req.name, firstTurn: null }
      }
      const firstTurn = await this.send(
        { name: req.name, prompt: req.prompt, timeoutMs: req.timeoutMs },
        ctx,
      )
      return { kind: 'spawned', name: req.name, firstTurn }
    } catch (e) {
      if (e instanceof CodexDaemonAlreadyAliveError) {
        return { kind: 'already-exists', existingEngine: 'codex' }
      }
      if (!(e instanceof CodexDaemonSpawnInProgressError)) {
        await reapDaemon(req.name)
        removeBaseRecord(req.name)
      }
      return {
        kind: 'failed',
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  async send(req: SendRequest, _ctx: EngineContext): Promise<TurnResult> {
    if (!daemonAlive(req.name)) {
      return {
        kind: 'failed',
        message: `codex teammate '${req.name}' is not alive — try 'tm spawn ${req.name}' first`,
        recoverable: false,
      }
    }
    if (req.prompt.length === 0) {
      return { kind: 'failed', message: 'usage: tm send <teammate> "<prompt>"', recoverable: false }
    }

    let client: CodexWsClient | null = null
    try {
      client = await openInitializedCodexClient(req.name)
      let threadId = readDaemonState(req.name)?.threadId ?? null
      if (threadId === null) {
        const resp = await client.request<'thread/start', ThreadStartResponse>('thread/start', {
          experimentalRawEvents: false,
          persistExtendedHistory: false,
        })
        threadId = resp.thread.id
        writeThreadId(req.name, threadId)
      } else {
        await client.request<'thread/resume', ThreadResumeResponse>('thread/resume', {
          threadId,
          persistExtendedHistory: false,
        })
      }

      const completed = await withTimeout(
        runTurn(client, threadId, req.prompt, { wait: true, cwd: null }),
        req.timeoutMs,
      )
      if (isTimedOut(completed)) return { kind: 'timed-out', elapsedMs: req.timeoutMs ?? 0 }
      if (completed === null) return { kind: 'no-op', reason: 'turn was started without waiting' }
      touchLastSeen(req.name)
      return turnNotificationToResult(completed)
    } catch (e) {
      return {
        kind: 'failed',
        message: `codex send on '${req.name}' failed: ${e instanceof Error ? e.message : String(e)}`,
        recoverable: true,
      }
    } finally {
      if (client !== null) client.close()
    }
  }

  async wait(req: WaitRequest, _ctx: EngineContext): Promise<TurnResult> {
    if (!daemonAlive(req.name)) {
      return { kind: 'failed', message: `codex teammate '${req.name}' is not alive`, recoverable: false }
    }
    const threadId = readDaemonState(req.name)?.threadId ?? null
    if (threadId === null) {
      return {
        kind: 'failed',
        message: `codex teammate '${req.name}' has no started thread yet — run 'tm send ${req.name} --prompt "…"' first`,
        recoverable: false,
      }
    }

    let client: CodexWsClient | null = null
    try {
      client = await openInitializedCodexClient(req.name)
      await client.request<'thread/resume', ThreadResumeResponse>('thread/resume', {
        threadId,
        persistExtendedHistory: false,
      })
      const collector = subscribeTurnCollection(client, threadId)
      const completed = await withTimeout(
        collector.awaitTurn(),
        req.timeoutMs,
      )
      if (isTimedOut(completed)) return { kind: 'timed-out', elapsedMs: req.timeoutMs ?? 0 }
      touchLastSeen(req.name)
      return turnNotificationToResult(completed)
    } catch (e) {
      return {
        kind: 'failed',
        message: `codex wait on '${req.name}' failed: ${e instanceof Error ? e.message : String(e)}`,
        recoverable: true,
      }
    } finally {
      if (client !== null) client.close()
    }
  }

  async kill(req: KillRequest, _ctx: EngineContext): Promise<KillResult> {
    const state = readDaemonState(req.name)
    const base = readBaseRecord(req.name)
    const meta = readCodexMeta(req.name)
    if (state === null && base === null && meta === null) return { kind: 'not-found' }
    try {
      await reapDaemon(req.name)
      removeBaseRecord(req.name)
      return { kind: 'killed' }
    } catch (e) {
      return { kind: 'failed', message: e instanceof Error ? e.message : String(e) }
    }
  }

  async list(ctx: EngineContext): Promise<readonly TeammateListing[]> {
    const nowSec = Math.floor(ctx.now() / 1000)
    return listDaemons().map((name) => {
      const state = readDaemonState(name)
      const base = readBaseRecord(name)
      const meta = readCodexMeta(name)
      return {
        name,
        engine: 'codex',
        state: codexDaemonState(name, state),
        cwd: base?.cwd ?? meta?.cwd ?? '',
        displayName: base?.displayName ?? meta?.displayName ?? null,
        extras: codexListExtras(name, nowSec, state),
      }
    })
  }

  async status(req: StatusRequest, _ctx: EngineContext): Promise<TeammateStatus> {
    const state = readDaemonState(req.name)
    const base = readBaseRecord(req.name)
    const meta = readCodexMeta(req.name)
    if (state === null && base === null && meta === null) return { kind: 'not-found' }
    return {
      kind: 'present',
      name: req.name,
      engine: 'codex',
      state: codexDaemonState(req.name, state),
      cwd: base?.cwd ?? meta?.cwd ?? '',
      pane: null,
      diagnostics: {
        pid: state?.pid === undefined ? '' : String(state.pid),
        socket: state?.socketPath ?? '',
        thread: state?.threadId ?? '',
        startedAt: state?.startedAt === undefined ? '' : String(state.startedAt),
        lastSeen: state?.lastSeen === null || state?.lastSeen === undefined ? '' : String(state.lastSeen),
      },
    }
  }

  async compact(_req: CompactRequest, _ctx: EngineContext): Promise<CompactResult> {
    return { kind: 'not-supported', reason: COMPACT_REASON }
  }

  async resume(_req: ResumeRequest, _ctx: EngineContext): Promise<ResumeResult> {
    return { kind: 'not-supported', reason: 'codex thread resume is internal to send/wait in Phase 2b' }
  }

  async last(_req: LastRequest, _ctx: EngineContext): Promise<TextResult> {
    return notSupported('codex app-server does not expose last-turn text as a standalone read')
  }

  async ctx(_req: ContextRequest, _ctx: EngineContext): Promise<ContextResult> {
    return { kind: 'not-supported', reason: 'codex context usage is not exposed through the Phase 2b engine yet' }
  }

  async history(_req: HistoryRequest, _ctx: EngineContext): Promise<HistoryResult> {
    return { kind: 'not-supported', reason: 'codex thread history enumeration is not exposed through the Phase 2b engine yet' }
  }

  async mem(_req: MemoryRequest, _ctx: EngineContext): Promise<TextResult> {
    return notSupported('codex does not use Claude project memory files')
  }

  async reload(_req: ReloadRequest, _ctx: EngineContext): Promise<ReloadResult> {
    return { kind: 'not-supported', reason: 'codex has no reload prompt command' }
  }

  async inspect(req: InspectRequest, _ctx: EngineContext): Promise<EngineSnapshot> {
    const status = await this.status({ name: req.name, lines: null }, _ctx)
    if (status.kind !== 'present') return { engine: 'codex', name: req.name, fields: { status: status.kind } }
    return { engine: 'codex', name: req.name, fields: status.diagnostics }
  }

  async doctor(_ctx: EngineContext): Promise<DoctorSection> {
    const findings: DoctorFinding[] = []
    for (const name of listDaemons()) {
      const state = readDaemonState(name)
      if (state === null) {
        await reapDaemon(name)
        findings.push({ severity: 'warn', summary: `reaped malformed codex daemon entry ${name}`, fix: null })
      } else if (!isProcessAlive(state.pid)) {
        await reapDaemon(name)
        findings.push({ severity: 'warn', summary: `reaped stale codex daemon ${name} (pid=${state.pid})`, fix: null })
      } else {
        findings.push({ severity: 'ok', summary: `${name} alive (pid=${state.pid})`, fix: null })
      }
    }
    return { engine: 'codex', findings }
  }

  private async healthCheck(name: string): Promise<void> {
    const initialized = await withTimeout(
      openInitializedCodexClient(name),
      this.options.readyTimeoutMs ?? 10000,
    )
    if (isTimedOut(initialized)) {
      throw new Error(`codex daemon '${name}' did not answer initialize within health-check timeout`)
    }
    const client = initialized
    client.close()
  }
}

/**
 * Open a fresh initialized connection to one per-teammate codex daemon.
 * Exported for the thin CLI compatibility wrappers and tests; the stream
 * itself remains codex-engine private and is not part of the Engine contract.
 */
export async function openInitializedCodexClient(name: string): Promise<CodexWsClient> {
  const state = readDaemonState(name)
  if (state === null) throw new Error(`codex daemon '${name}' has no registry state`)
  const client = new CodexWsClient({ socketPath: state.socketPath })
  try {
    await client.ready()
    await client.request<'initialize', InitializeResponse>('initialize', {
      clientInfo: CODEX_CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    })
    return client
  } catch (e) {
    client.close()
    throw e
  }
}
