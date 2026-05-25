/**
 * Codex Engine implementation.
 *
 * This is the Phase 2b migration target for the former root-level
 * `codex-verbs.ts` logic. Codex keeps its JSON-RPC notification stream,
 * daemon supervision, and `/tmp/teammate-codex/<name>/` registry private to
 * this directory; the public surface is the shared `Engine` interface.
 */

import { Buffer } from 'node:buffer'

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
import type { Turn } from '../../codex-protocol/v2/Turn.js'
import type { TurnItemsView } from '../../codex-protocol/v2/TurnItemsView.js'
import type { ThreadItem } from '../../codex-protocol/v2/ThreadItem.js'
import type { ThreadListResponse } from '../../codex-protocol/v2/ThreadListResponse.js'
import type { ThreadReadResponse } from '../../codex-protocol/v2/ThreadReadResponse.js'
import type { ThreadResumeResponse } from '../../codex-protocol/v2/ThreadResumeResponse.js'
import type { ThreadStartResponse } from '../../codex-protocol/v2/ThreadStartResponse.js'
import type { ThreadTokenUsage } from '../../codex-protocol/v2/ThreadTokenUsage.js'
import { EXIT_SYNC_WAIT_EXPIRED, type TmResult } from '../../tm'
import type { CollectedTurn, TurnCompletedNotification } from './events.js'
import { codexHistory } from './history.js'
import { CodexWsClient } from './rpc.js'
import { runTurn, subscribeTurnCollection } from './events.js'
import {
  CodexDaemonAlreadyAliveError,
  CodexDaemonSpawnInProgressError,
  daemonAlive,
  daemonBorrowed,
  daemonSpawnInProgress,
  isProcessAlive,
  listDaemons,
  readDaemonState,
  reapDaemon,
  releaseDaemonBorrow,
  spawnDaemon,
  touchLastSeen,
  tryBorrowDaemon,
  writeThreadId,
} from './supervisor.js'
import {
  CodexTeammateRecord,
  codexLastTurnFile,
  readBaseRecord,
  readCodexMeta,
  readCodexLastTurn,
  removeBaseRecord,
  reserveBaseRecord,
  writeCodexLastTurn,
} from './persistence.js'
import {
  type CodexRolloutSnapshot,
  CODEX_ROLLOUT_BUSY_WINDOW_MS,
  readCodexRolloutSnapshot,
  rolloutRecentlyActive,
} from './rollout.js'
import { validateTeammateName } from '../../identity/name.js'
import { looksLikeUuidPrefix } from '../../identity/uuid-prefix.js'

export const CODEX_CLIENT_INFO: ClientInfo = {
  name: 'claudemux',
  title: null,
  version: '1.0.0',
}

const COMPACT_REASON =
  'codex compacts its own context automatically when the 252k window fills'
const CODEX_STATUS_RPC_TIMEOUT_MS = 250
const CODEX_THREAD_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NO_TEXT_REPLY =
  '(no text reply this turn — tool-only, /compact, /clear, or fresh spawn)'

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

function finalAssistantText(items: readonly ThreadItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item?.type !== 'agentMessage') continue
    if (item.text.length === 0) continue
    return item.text
  }
  return null
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

function fmtTokenWindow(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens >= 1000 && tokens % 1000 === 0) return `${tokens / 1000}k`
  return String(tokens)
}

function contextFromThreadTokenUsage(tokenUsage: ThreadTokenUsage | null): ContextResult | null {
  if (tokenUsage === null) return null
  const window = tokenUsage.modelContextWindow
  if (window === null || window <= 0) return null
  const used = tokenUsage.last.totalTokens
  return {
    kind: 'usage',
    tokensUsed: used,
    tokensTotal: window,
    pct: Math.floor((used * 100) / window),
  }
}

function contextFromRollout(threadId: string, ctx: EngineContext): ContextResult | null {
  const usage = readCodexRolloutSnapshot(threadId, ctx.env)?.tokenUsage ?? null
  if (usage === null) return null
  return {
    kind: 'usage',
    tokensUsed: usage.tokensUsed,
    tokensTotal: usage.tokensTotal,
    pct: usage.pct,
  }
}

function contextForCollectedTurn(outcome: CollectedTurn, ctx: EngineContext): ContextResult | null {
  return contextFromThreadTokenUsage(outcome.tokenUsage) ?? contextFromRollout(outcome.completed.threadId, ctx)
}

function formatCtxForStderr(context: ContextResult | null): string {
  if (context?.kind !== 'usage') return 'ctx: (no usage data)\n'
  return `ctx: ${context.tokensUsed} tokens · ${context.pct}% of ${fmtTokenWindow(context.tokensTotal)}\n`
}

function codexTurnStderr(args: {
  readonly name: string
  readonly action: 'sent' | 'waited'
  readonly threadId: string
  readonly context: ContextResult | null
  readonly rawPath: string
}): string {
  const prefix = args.action === 'sent' ? `sent to ${args.name}` : `waited on ${args.name}`
  return (
    `${prefix} (codex)\n` +
    `sid=${args.threadId}\n` +
    formatCtxForStderr(args.context) +
    `raw: ${args.rawPath}\n`
  )
}

function writeLastTurn(name: string, completed: TurnCompletedNotification): string {
  const rawPath = codexLastTurnFile(name)
  writeCodexLastTurn(name, ensureTrailingNewline(JSON.stringify(completed, null, 2)))
  return rawPath
}

/**
 * Pick the latest `Turn` from a `thread/read` snapshot that reached a
 * terminal state AFTER the daemon's `lastSeen` marker — the candidate
 * `tm wait` should surface as a backfill instead of subscribing to a
 * future event the dispatcher would never see.
 *
 * Why this exists: `tm send` on Codex opens a WS, posts a turn, and
 * closes on `--timeout` expiry (exit 124). The follow-up `tm wait` opens
 * a fresh WS and `subscribeTurnCollection` only ever receives events
 * that fire AFTER the subscription is in place — so a turn that finished
 * in the window [send-timeout, wait-subscribe] is invisible to the
 * notification stream alone. `tm wait` now calls `thread/read` with
 * `includeTurns: true` alongside the subscription and races them; if
 * `lastSeen` < some terminal turn, that turn becomes the resolved value
 * and `tm wait` returns it.
 *
 * Filters:
 *  - `inProgress` is skipped — the live subscription will deliver it.
 *    Every OTHER status is terminal (the Codex protocol's `TurnStatus`
 *    union is `completed | failed | interrupted | inProgress`) and must
 *    be eligible for backfill: the dispatcher needs the late `failed` /
 *    `interrupted` outcome just as much as a late `completed`, or the
 *    next `tm wait` keeps spinning to 124 on a turn that already
 *    settled into an error state. `turnNotificationToResult` is the
 *    single mapping site that translates any terminal status to a
 *    `TurnResult`, so backfill and live paths cannot drift.
 *  - `completedAt === null` is defensive — a turn whose timestamp
 *    didn't survive serialization cannot be ordered against `lastSeen`.
 *  - `completedAt <= lastSeen` means the dispatcher already saw it.
 *
 * Picks the max `completedAt` among survivors — `thread.turns` ordering
 * is not documented as ascending, so a scan is the contract-safe form.
 */
export function pickBackfillTurn(
  turns: readonly Turn[],
  lastSeen: number,
  threadId: string,
): TurnCompletedNotification | null {
  let best: Turn | null = null
  let bestCompletedAt = 0
  for (const turn of turns) {
    if (turn.status === 'inProgress') continue
    if (turn.completedAt === null) continue
    if (turn.completedAt <= lastSeen) continue
    if (best === null || turn.completedAt > bestCompletedAt) {
      best = turn
      bestCompletedAt = turn.completedAt
    }
  }
  if (best === null) return null
  // Match `subscribeTurnCollection`'s synthesis convention so downstream
  // `turnNotificationToResult` reads the same shape regardless of source.
  const itemsView: TurnItemsView = best.items.length > 0 ? 'full' : 'notLoaded'
  return {
    threadId,
    turn: { ...best, itemsView },
  }
}

export function turnNotificationToResult(
  completed: TurnCompletedNotification,
  options: {
    readonly name?: string
    readonly action?: 'sent' | 'waited'
    readonly context?: ContextResult | null
    readonly rawPath?: string
  } = {},
): TurnResult {
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
  const text = ensureTrailingNewline(finalAssistantText(completed.turn.items) ?? NO_TEXT_REPLY)
  const context = options.context ?? null
  const base = { kind: 'completed' as const, text, items, context }
  if (options.name === undefined || options.action === undefined || options.rawPath === undefined) {
    return base
  }
  return {
    ...base,
    tmResult: {
      code: 0,
      stdout: text,
      stderr: codexTurnStderr({
        name: options.name,
        action: options.action,
        threadId: completed.threadId,
        context,
        rawPath: options.rawPath,
      }),
    },
  }
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

function closeClientWhenSettled(clientPromise: Promise<CodexWsClient>): void {
  clientPromise.then(
    (lateClient) => lateClient.close(),
    () => {},
  )
}

function codexNameFailure(name: string): string | null {
  const validation = validateTeammateName(name)
  return validation.kind === 'ok'
    ? null
    : `invalid codex teammate name '${name}': ${validation.reason}`
}

function codexThreadIdFailure(threadId: string, name: string | null = null): string | null {
  if (CODEX_THREAD_ID_RE.test(threadId)) return null
  if (name !== null && looksLikeUuidPrefix(threadId)) {
    return (
      `received '${threadId}', looks like a thread-id prefix; resume ` +
      `requires the full thread id. Run 'tm history ${name} ${threadId}' to ` +
      `expand it, or 'tm history ${name}' to list past threads with full ids.`
    )
  }
  return `codex thread id is not a valid uuid: ${threadId}`
}

async function latestCodexThreadIdForCwd(
  client: CodexWsClient,
  cwd: string,
): Promise<string | null> {
  const response = await client.request<'thread/list', ThreadListResponse>('thread/list', {
    limit: 1,
    sortKey: 'updated_at',
    sortDirection: 'desc',
    archived: false,
    cwd,
    useStateDbOnly: false,
  })
  return response.data[0]?.id ?? null
}

function codexSpawnHeader(name: string): string {
  const state = readDaemonState(name)
  return state === null
    ? `spawned: ${name}\n`
    : `spawned: ${name} (pid=${state.pid}, socket=${state.socketPath})\n`
}

function codexResumeHeader(name: string): string {
  const state = readDaemonState(name)
  return state === null
    ? `resumed: ${name}\n`
    : `resumed: ${name} (pid=${state.pid}, socket=${state.socketPath})\n`
}

function formatFirstTurn(turn: TurnResult): TmResult {
  if (turn.tmResult !== undefined) return turn.tmResult
  switch (turn.kind) {
    case 'completed':
      return { code: 0, stdout: turn.text.endsWith('\n') ? turn.text : `${turn.text}\n`, stderr: '' }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: turn failed: ${turn.message}\n` }
    case 'timed-out':
      return {
        code: EXIT_SYNC_WAIT_EXPIRED,
        stdout: '',
        stderr:
          `tm: sync wait expired after ${turn.elapsedMs}ms (the codex daemon ` +
          `did not return a Turn within the window; it is still running). ` +
          `exit ${EXIT_SYNC_WAIT_EXPIRED}.\n`,
      }
    case 'not-supported':
      return { code: 0, stdout: '', stderr: `  not supported: ${turn.reason}\n` }
    case 'no-op':
      return { code: 0, stdout: '', stderr: `  no-op: ${turn.reason}\n` }
  }
}

function fmtAge(age: number): string {
  if (age < 60) return `${age}s`
  if (age < 3600) return `${Math.floor(age / 60)}m`
  if (age < 86400) return `${Math.floor(age / 3600)}h`
  return `${Math.floor(age / 86400)}d`
}

interface CodexRuntimeProbe {
  readonly socketReachable: 'yes' | 'no' | 'unknown'
  readonly threadStatus: string | null
  readonly threadState: 'idle' | 'busy' | 'unknown' | null
}

function statusState(statusType: string | null): CodexRuntimeProbe['threadState'] {
  switch (statusType) {
    case 'active':
      return 'busy'
    case 'idle':
    case 'notLoaded':
      return 'idle'
    case 'systemError':
      return 'unknown'
    default:
      return null
  }
}

function codexDaemonState(
  name: string,
  state: ReturnType<typeof readDaemonState> = readDaemonState(name),
  runtime: CodexRuntimeProbe | null = null,
  rollout: CodexRolloutSnapshot | null = null,
  nowMs = Date.now(),
): 'idle' | 'busy' | 'unknown' {
  if (state === null || !isProcessAlive(state.pid)) return 'unknown'
  if (runtime?.threadState === 'busy') return 'busy'
  if (daemonBorrowed(name)) return 'busy'
  if (rolloutRecentlyActive(rollout, nowMs)) return 'busy'
  if (runtime?.threadState === 'idle') return 'idle'
  if (runtime?.threadState === 'unknown' || runtime?.socketReachable === 'no') return 'unknown'
  return 'idle'
}

function codexPreview(text: string): string {
  const preview = [...(text.split('\n')[0] ?? '')]
    .filter((ch) => (ch.codePointAt(0) ?? 0) > 0x1f)
    .slice(0, 50)
    .join('')
  return preview.length > 0 ? preview : '(no first line)'
}

function codexLastTextCells(
  rollout: CodexRolloutSnapshot | null,
  nowSec: number,
): { readonly last: string; readonly preview: string } | null {
  if (rollout?.lastAssistantText === null || rollout?.lastAssistantText === undefined) return null
  const assistantAtMs = rollout.lastAssistantAtMs ?? rollout.mtimeMs
  const age = Math.max(0, nowSec - Math.floor(assistantAtMs / 1000))
  return {
    last: `${Buffer.byteLength(rollout.lastAssistantText, 'utf8')}B/${fmtAge(age)}`,
    preview: codexPreview(rollout.lastAssistantText),
  }
}

function codexListExtras(
  nowSec: number,
  state: ReturnType<typeof readDaemonState>,
  daemonState: 'idle' | 'busy' | 'unknown',
  rollout: CodexRolloutSnapshot | null,
  runtime: CodexRuntimeProbe | null,
): Readonly<Record<string, string>> {
  const pid = state?.pid === undefined ? '' : String(state.pid)
  const thread = state?.threadId ?? ''
  const rolloutSeen = rollout === null ? null : Math.floor(rollout.mtimeMs / 1000)
  const lastText = codexLastTextCells(rollout, nowSec)
  const recordedSeen = state?.lastSeen ?? null
  const activitySeen =
    recordedSeen === null ? rolloutSeen : rolloutSeen === null ? recordedSeen : Math.max(recordedSeen, rolloutSeen)
  const lastSeen = activitySeen === null ? '' : String(activitySeen)
  return {
    sidShort: thread.length === 0 ? 'codex' : thread.slice(0, 8),
    busy: daemonState === 'busy' ? 'yes' : daemonState === 'idle' ? 'no' : '?',
    last: lastText?.last ?? '-',
    preview: lastText?.preview ?? '-',
    pid,
    socket: state?.socketPath ?? '',
    socketReachable: runtime?.socketReachable ?? 'unknown',
    thread,
    lastSeen,
    rollout: rollout?.path ?? '',
    threadStatus: runtime?.threadStatus ?? '',
  }
}

function statusPane(args: {
  readonly name: string
  readonly state: ReturnType<typeof readDaemonState>
  readonly base: ReturnType<typeof readBaseRecord>
  readonly meta: ReturnType<typeof readCodexMeta>
  readonly daemonState: 'idle' | 'busy' | 'unknown'
  readonly rollout: CodexRolloutSnapshot | null
  readonly runtime: CodexRuntimeProbe | null
  readonly nowSec: number
}): string {
  const activitySeen =
    args.rollout === null
      ? args.state?.lastSeen ?? null
      : Math.max(args.state?.lastSeen ?? 0, Math.floor(args.rollout.mtimeMs / 1000))
  const activityAge = activitySeen === null ? '-' : fmtAge(Math.max(0, args.nowSec - activitySeen))
  return [
    `codex: ${args.name}`,
    `state: ${args.daemonState}`,
    `cwd: ${args.base?.cwd ?? args.meta?.cwd ?? ''}`,
    `pid: ${args.state?.pid === undefined ? '-' : String(args.state.pid)}`,
    `socket: ${args.state?.socketPath ?? '-'}`,
    `socket reachable: ${args.runtime?.socketReachable ?? 'unknown'}`,
    `thread: ${args.state?.threadId ?? '-'}`,
    `thread status: ${args.runtime?.threadStatus ?? '-'}`,
    `started: ${args.state?.startedAt === undefined ? '-' : String(args.state.startedAt)}`,
    `last activity: ${activitySeen === null ? '-' : `${activitySeen} (${activityAge} ago)`}`,
    `rollout: ${args.rollout?.path ?? '-'}`,
  ].join('\n') + '\n'
}

export class CodexEngine implements Engine {
  readonly kind: EngineKind = 'codex'
  readonly capabilities: EngineCapabilities = {
    atomicSend: true,
    atomicSpawnPrompt: true,
    compaction: 'auto',
    contextUsage: 'transcript-jsonl',
    history: 'transcript-files',
    memory: 'unsupported',
    reload: 'unsupported',
    resume: 'thread-id',
    detachedTurn: 'unsupported',
    events: 'push',
  }

  constructor(private readonly options: CodexEngineOptions = {}) {}

  async spawn(req: SpawnRequest, ctx: EngineContext): Promise<SpawnResult> {
    const invalidName = codexNameFailure(req.name)
    if (invalidName !== null) return { kind: 'failed', message: invalidName }
    if (req.resumeCheckpoint !== null) {
      return { kind: 'failed', message: '--resume is not supported for codex teammates' }
    }

    const existing = readBaseRecord(req.name)
    if (existing !== null) {
      if (existing.engine !== 'codex') return { kind: 'already-exists', existingEngine: existing.engine }
      if (daemonAlive(req.name)) return { kind: 'already-exists', existingEngine: 'codex' }
      if (daemonSpawnInProgress(req.name)) return { kind: 'already-exists', existingEngine: 'codex' }
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
    const reserved = reserveBaseRecord(record)
    if (reserved.kind === 'taken') {
      return { kind: 'already-exists', existingEngine: reserved.existing.engine }
    }
    if (reserved.kind === 'failed') return { kind: 'failed', message: reserved.message }

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

      if (req.prompt === null) {
        return {
          kind: 'spawned',
          name: req.name,
          firstTurn: null,
          tmResult: { code: 0, stdout: '', stderr: codexSpawnHeader(req.name) },
        }
      }
      const firstTurn = await this.send(
        { name: req.name, prompt: req.prompt, timeoutMs: req.timeoutMs, paneQuiet: false },
        ctx,
      )
      const turn = formatFirstTurn(firstTurn)
      return {
        kind: 'spawned',
        name: req.name,
        firstTurn,
        tmResult: {
          code: turn.code,
          stdout: turn.stdout,
          stderr: codexSpawnHeader(req.name) + turn.stderr,
        },
      }
    } catch (e) {
      removeBaseRecord(req.name)
      if (e instanceof CodexDaemonAlreadyAliveError) {
        return { kind: 'already-exists', existingEngine: 'codex' }
      }
      if (!(e instanceof CodexDaemonSpawnInProgressError)) {
        await reapDaemon(req.name)
      }
      return {
        kind: 'failed',
        message: e instanceof Error ? e.message : String(e),
      }
    }
  }

  async send(req: SendRequest, ctx: EngineContext): Promise<TurnResult> {
    const invalidName = codexNameFailure(req.name)
    if (invalidName !== null) {
      return { kind: 'failed', message: invalidName, recoverable: false }
    }
    if (req.paneQuiet) {
      return {
        kind: 'failed',
        message: 'tm send: --pane-quiet is not supported for codex teammates',
        recoverable: false,
      }
    }
    if (!daemonAlive(req.name)) {
      return {
        kind: 'failed',
        message: `codex teammate '${req.name}' is not alive — try 'tm spawn ${req.name} --engine codex' first`,
        recoverable: false,
      }
    }
    if (req.prompt.length === 0) {
      return { kind: 'failed', message: 'usage: tm send <teammate> "<prompt>"', recoverable: false }
    }
    if (!tryBorrowDaemon(req.name)) {
      return { kind: 'failed', message: `codex teammate '${req.name}' is busy`, recoverable: true }
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

      const outcome = await withTimeout(
        runTurn(client, threadId, req.prompt, { wait: true, cwd: null }),
        req.timeoutMs,
      )
      if (isTimedOut(outcome)) return { kind: 'timed-out', elapsedMs: req.timeoutMs ?? 0 }
      if (outcome === null) return { kind: 'no-op', reason: 'turn was started without waiting' }
      const rawPath = writeLastTurn(req.name, outcome.completed)
      touchLastSeen(req.name)
      return turnNotificationToResult(outcome.completed, {
        name: req.name,
        action: 'sent',
        context: contextForCollectedTurn(outcome, ctx),
        rawPath,
      })
    } catch (e) {
      return {
        kind: 'failed',
        message: `codex send on '${req.name}' failed: ${e instanceof Error ? e.message : String(e)}`,
        recoverable: true,
      }
    } finally {
      if (client !== null) client.close()
      releaseDaemonBorrow(req.name)
    }
  }

  async wait(req: WaitRequest, ctx: EngineContext): Promise<TurnResult> {
    const invalidName = codexNameFailure(req.name)
    if (invalidName !== null) {
      return { kind: 'failed', message: invalidName, recoverable: false }
    }
    if (req.fresh) {
      return {
        kind: 'failed',
        message: 'tm wait: --fresh is not supported for codex teammates',
        recoverable: false,
      }
    }
    if (req.paneQuiet) {
      return {
        kind: 'failed',
        message: 'tm wait: --pane-quiet is not supported for codex teammates',
        recoverable: false,
      }
    }
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
      // Order matters: subscribe BEFORE issuing thread/read, so a turn that
      // completes between the read response and the subscription setup is
      // not dropped (subscribeTurnCollection registers a notification
      // handler immediately; lateInbounds buffer until awaitTurn fires).
      const collector = subscribeTurnCollection(client, threadId)
      const lastSeen = readDaemonState(req.name)?.lastSeen ?? 0
      const readPromise = client.request<'thread/read', ThreadReadResponse>('thread/read', {
        threadId,
        includeTurns: true,
      })
      // Race the live subscription against the backfill read. If a turn
      // completed in [send-timeout, wait-subscribe], the read finds it
      // and resolves first; otherwise the read returns no candidate and
      // we hand off to the collector (which may already have a live
      // event cached from notifications that arrived during the read).
      // The 124 contract — "still running, re-collect with tm wait" —
      // now actually holds for Codex: the second wait recovers the
      // in-window completion. If the wall-clock --timeout fires before
      // the read RPC returns, control still reaches `isTimedOut(outcome)`
      // and the caller gets the documented 124; the next `tm wait`
      // catches the completion via the same backfill path.
      //
      // A thread/read RPC error is non-fatal here: the live subscription
      // is the original (pre-backfill) source of truth, and a snapshot
      // failure should not turn a healthy wait into a failed verb. Swallow
      // the rejection and fall through to the collector.
      const backfillRace: Promise<CollectedTurn> = readPromise.then(
        (read) => {
          const backfill = pickBackfillTurn(read.thread.turns, lastSeen, threadId)
          if (backfill !== null) return { completed: backfill, tokenUsage: null }
          return collector.awaitTurn()
        },
        () => collector.awaitTurn(),
      )
      const outcome = await withTimeout(
        Promise.race([collector.awaitTurn(), backfillRace]),
        req.timeoutMs,
      )
      if (isTimedOut(outcome)) {
        // Swallow the readPromise rejection (if any) so the WS close in
        // `finally` does not race with an unhandled rejection.
        readPromise.catch(() => {})
        return { kind: 'timed-out', elapsedMs: req.timeoutMs ?? 0 }
      }
      const rawPath = writeLastTurn(req.name, outcome.completed)
      touchLastSeen(req.name)
      return turnNotificationToResult(outcome.completed, {
        name: req.name,
        action: 'waited',
        context: contextForCollectedTurn(outcome, ctx),
        rawPath,
      })
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
    const nowMs = ctx.now()
    return Promise.all(listDaemons().map(async (name) => {
      const state = readDaemonState(name)
      const base = readBaseRecord(name)
      const meta = readCodexMeta(name)
      const rollout = state?.threadId === null || state?.threadId === undefined
        ? null
        : readCodexRolloutSnapshot(state.threadId, ctx.env)
      const runtime = await this.probeRuntime(name, state)
      const daemonState = codexDaemonState(name, state, runtime, rollout, nowMs)
      return {
        name,
        engine: 'codex',
        state: daemonState,
        cwd: base?.cwd ?? meta?.cwd ?? '',
        displayName: base?.displayName ?? meta?.displayName ?? null,
        extras: codexListExtras(nowSec, state, daemonState, rollout, runtime),
      }
    }))
  }

  async status(req: StatusRequest, ctx: EngineContext): Promise<TeammateStatus> {
    const state = readDaemonState(req.name)
    const base = readBaseRecord(req.name)
    const meta = readCodexMeta(req.name)
    if (state === null && base === null && meta === null) return { kind: 'not-found' }
    const rollout = state?.threadId === null || state?.threadId === undefined
      ? null
      : readCodexRolloutSnapshot(state.threadId, ctx.env)
    const runtime = await this.probeRuntime(req.name, state)
    const daemonState = codexDaemonState(req.name, state, runtime, rollout, ctx.now())
    return {
      kind: 'present',
      name: req.name,
      engine: 'codex',
      state: daemonState,
      cwd: base?.cwd ?? meta?.cwd ?? '',
      pane: statusPane({
        name: req.name,
        state,
        base,
        meta,
        daemonState,
        rollout,
        runtime,
        nowSec: Math.floor(ctx.now() / 1000),
      }),
      diagnostics: {
        pid: state?.pid === undefined ? '' : String(state.pid),
        socket: state?.socketPath ?? '',
        socketReachable: runtime?.socketReachable ?? 'unknown',
        thread: state?.threadId ?? '',
        threadStatus: runtime?.threadStatus ?? '',
        startedAt: state?.startedAt === undefined ? '' : String(state.startedAt),
        lastSeen: state?.lastSeen === null || state?.lastSeen === undefined ? '' : String(state.lastSeen),
        rollout: rollout?.path ?? '',
        rolloutMtime: rollout === null ? '' : String(Math.floor(rollout.mtimeMs / 1000)),
        busyWindowMs: String(CODEX_ROLLOUT_BUSY_WINDOW_MS),
      },
    }
  }

  async compact(_req: CompactRequest, _ctx: EngineContext): Promise<CompactResult> {
    return { kind: 'not-supported', reason: COMPACT_REASON }
  }

  async resume(req: ResumeRequest, ctx: EngineContext): Promise<ResumeResult> {
    const invalidName = codexNameFailure(req.name)
    if (invalidName !== null) return { kind: 'failed', message: invalidName }
    let threadId = req.checkpoint
    const invalidThreadId = threadId === null ? null : codexThreadIdFailure(threadId, req.name)
    if (invalidThreadId !== null) return { kind: 'failed', message: invalidThreadId }

    const existing = readBaseRecord(req.name)
    if (existing !== null) {
      if (existing.engine !== 'codex') {
        return { kind: 'failed', message: `'${req.name}' already exists as a ${existing.engine} teammate` }
      }
      if (daemonAlive(req.name) || daemonSpawnInProgress(req.name)) {
        return { kind: 'failed', message: `codex teammate '${req.name}' is already running` }
      }
      removeBaseRecord(req.name)
    }
    if (daemonAlive(req.name)) {
      return { kind: 'failed', message: `codex teammate '${req.name}' is already running` }
    }
    if (daemonSpawnInProgress(req.name)) {
      return { kind: 'failed', message: `codex teammate '${req.name}' is already being spawned` }
    }

    const createdAt = Math.floor(ctx.now() / 1000)
    const cwd = req.cwd ?? process.cwd()
    const record = new CodexTeammateRecord({
      name: req.name,
      cwd,
      createdAt,
      displayName: req.displayName,
    })
    const reserved = reserveBaseRecord(record)
    if (reserved.kind === 'taken') {
      return { kind: 'failed', message: `'${req.name}' already exists as a ${reserved.existing.engine} teammate` }
    }
    if (reserved.kind === 'failed') return { kind: 'failed', message: reserved.message }

    let client: CodexWsClient | null = null
    try {
      await spawnDaemon({
        name: req.name,
        binPath: this.options.binPath,
        cwd,
        env: ctx.env,
        readyTimeoutMs: this.options.readyTimeoutMs,
        meta: {
          schema: 1,
          name: req.name,
          cwd,
          displayName: req.displayName,
          spawnedAt: createdAt,
        },
      })

      await this.healthCheck(req.name)
      client = await openInitializedCodexClient(req.name)
      if (threadId === null) {
        threadId = await latestCodexThreadIdForCwd(client, cwd)
        if (threadId === null) {
          client.close()
          client = null
          removeBaseRecord(req.name)
          await reapDaemon(req.name)
          return { kind: 'not-found', reason: `no codex threads found for cwd ${cwd}` }
        }
        const latestInvalidThreadId = codexThreadIdFailure(threadId)
        if (latestInvalidThreadId !== null) {
          throw new Error(`thread/list returned invalid thread id: ${threadId}`)
        }
      }
      writeThreadId(req.name, threadId)
      await client.request<'thread/resume', ThreadResumeResponse>('thread/resume', {
        threadId,
        persistExtendedHistory: false,
      })
      touchLastSeen(req.name)
      client.close()
      client = null

      if (req.prompt === null) {
        return {
          kind: 'resumed',
          checkpoint: threadId,
          tmResult: {
            code: 0,
            stdout: `resumed: ${threadId}\n`,
            stderr: codexResumeHeader(req.name),
          },
        }
      }
      const turn = formatFirstTurn(await this.send(
        { name: req.name, prompt: req.prompt, timeoutMs: null, paneQuiet: false },
        ctx,
      ))
      return {
        kind: 'resumed',
        checkpoint: threadId,
        tmResult: {
          code: turn.code,
          stdout: turn.stdout,
          stderr: codexResumeHeader(req.name) + turn.stderr,
        },
      }
    } catch (e) {
      removeBaseRecord(req.name)
      if (e instanceof CodexDaemonAlreadyAliveError) {
        return { kind: 'failed', message: e.message }
      }
      if (!(e instanceof CodexDaemonSpawnInProgressError)) {
        await reapDaemon(req.name)
      }
      return {
        kind: 'failed',
        message: e instanceof Error ? e.message : String(e),
      }
    } finally {
      if (client !== null) client.close()
    }
  }

  async last(req: LastRequest, ctx: EngineContext): Promise<TextResult> {
    if (req.verbose) {
      const raw = readCodexLastTurn(req.name)
      if (raw === null) return { kind: 'not-found', reason: `codex teammate '${req.name}' has no raw last turn` }
      return { kind: 'text', text: ensureTrailingNewline(raw) }
    }
    const threadId = readDaemonState(req.name)?.threadId ?? null
    if (threadId === null) return { kind: 'not-found', reason: `codex teammate '${req.name}' has no thread id` }
    const rollout = readCodexRolloutSnapshot(threadId, ctx.env)
    if (rollout === null) return { kind: 'not-found', reason: `codex rollout for thread '${threadId}' not found` }
    if (rollout.lastAssistantText === null) {
      return { kind: 'not-found', reason: `no assistant text in codex rollout ${rollout.path}` }
    }
    return {
      kind: 'text',
      text: rollout.lastAssistantText.endsWith('\n')
        ? rollout.lastAssistantText
        : `${rollout.lastAssistantText}\n`,
    }
  }

  async ctx(req: ContextRequest, ctx: EngineContext): Promise<ContextResult> {
    const threadId = readDaemonState(req.name)?.threadId ?? null
    if (threadId === null) {
      return { kind: 'not-supported', reason: `codex teammate '${req.name}' has no thread id` }
    }
    const rollout = readCodexRolloutSnapshot(threadId, ctx.env)
    if (rollout === null) {
      return { kind: 'not-supported', reason: `codex rollout for thread '${threadId}' not found` }
    }
    if (rollout.tokenUsage === null) {
      return { kind: 'not-supported', reason: `no token usage in codex rollout ${rollout.path}` }
    }
    return {
      kind: 'usage',
      tokensUsed: rollout.tokenUsage.tokensUsed,
      tokensTotal: rollout.tokenUsage.tokensTotal,
      pct: rollout.tokenUsage.pct,
    }
  }

  async history(_req: HistoryRequest, _ctx: EngineContext): Promise<HistoryResult> {
    return codexHistory(_req, _ctx)
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
        removeBaseRecord(name)
        findings.push({ severity: 'warn', summary: `reaped malformed codex daemon entry ${name}`, fix: null })
      } else if (!isProcessAlive(state.pid)) {
        await reapDaemon(name)
        removeBaseRecord(name)
        findings.push({ severity: 'warn', summary: `reaped stale codex daemon ${name} (pid=${state.pid})`, fix: null })
      } else {
        findings.push({ severity: 'ok', summary: `${name} alive (pid=${state.pid})`, fix: null })
      }
    }
    return { engine: 'codex', findings }
  }

  private async healthCheck(name: string): Promise<void> {
    const clientPromise = openInitializedCodexClient(name)
    const initialized = await withTimeout(clientPromise, this.options.readyTimeoutMs ?? 10000)
    if (isTimedOut(initialized)) {
      closeClientWhenSettled(clientPromise)
      throw new Error(`codex daemon '${name}' did not answer initialize within health-check timeout`)
    }
    const client = initialized
    client.close()
  }

  private async probeRuntime(
    name: string,
    state: ReturnType<typeof readDaemonState>,
  ): Promise<CodexRuntimeProbe | null> {
    if (state === null || !isProcessAlive(state.pid)) return null
    let client: CodexWsClient | null = null
    try {
      const clientPromise = openInitializedCodexClient(name)
      const initialized = await withTimeout(clientPromise, CODEX_STATUS_RPC_TIMEOUT_MS)
      if (isTimedOut(initialized)) {
        closeClientWhenSettled(clientPromise)
        return { socketReachable: 'no', threadStatus: null, threadState: null }
      }
      client = initialized
      if (state.threadId === null) {
        return { socketReachable: 'yes', threadStatus: null, threadState: null }
      }
      try {
        const readPromise = client.request<'thread/read', ThreadReadResponse>('thread/read', {
          threadId: state.threadId,
          includeTurns: false,
        })
        const read = await withTimeout(readPromise, CODEX_STATUS_RPC_TIMEOUT_MS)
        if (isTimedOut(read)) {
          readPromise.catch(() => {})
          client.close()
          client = null
          return { socketReachable: 'yes', threadStatus: null, threadState: null }
        }
        const statusType = read.thread.status.type
        return {
          socketReachable: 'yes',
          threadStatus: statusType,
          threadState: statusState(statusType),
        }
      } catch {
        return { socketReachable: 'yes', threadStatus: null, threadState: null }
      }
    } catch {
      return { socketReachable: 'no', threadStatus: null, threadState: null }
    } finally {
      if (client !== null) client.close()
    }
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
