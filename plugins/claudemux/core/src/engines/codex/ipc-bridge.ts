import { setTimeout as sleep } from 'node:timers/promises'

import type {
  ClientRequest,
  InitializeResponse,
  ServerNotification,
  ServerRequest,
} from '../../codex-protocol/index.js'
import type {
  Thread,
  ThreadCompactStartResponse,
  ThreadReadResponse,
  ThreadResumeResponse,
  ThreadSettingsUpdateResponse,
  ThreadStatus,
  Turn,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
  TurnSteerParams,
  TurnSteerResponse,
} from '../../codex-protocol/v2/index.js'
import { daemonAlive, readDaemonState } from './supervisor.js'
import { CodexWsClient } from './rpc.js'
import {
  CodexUiIpcClient,
  codexUiIpcSocketExists,
  codexUiIpcSocketPath,
  type IpcBroadcastContext,
  type IpcRequestContext,
} from './ui-ipc.js'

const CODEX_UI_HOST_ID = 'local'
// Matches Codex extension 26.519.x's IPC schema version for thread-stream-state-changed.
const CODEX_UI_STREAM_VERSION = 6
const CODEX_IPC_RETRY_MS = 1000
const CODEX_IPC_POLL_MS = 1000
const CODEX_IPC_SNAPSHOT_DEBOUNCE_MS = 100

const CODEX_CLIENT_INFO = {
  name: 'claudemux',
  title: null,
  version: '1.0.0',
}

const FOLLOWER_METHODS = new Set([
  'thread-follower-start-turn',
  'thread-follower-compact-thread',
  'thread-follower-steer-turn',
  'thread-follower-interrupt-turn',
  'thread-follower-set-model-and-reasoning',
  'thread-follower-set-collaboration-mode',
  'thread-follower-command-approval-decision',
  'thread-follower-file-approval-decision',
  'thread-follower-permissions-request-approval-response',
  'thread-follower-submit-user-input',
  'thread-follower-submit-mcp-server-elicitation-response',
])

const TURN_START_OPTIONAL_KEYS = [
  'responsesapiClientMetadata',
  'environments',
  'cwd',
  'runtimeWorkspaceRoots',
  'approvalPolicy',
  'approvalsReviewer',
  'sandboxPolicy',
  'permissions',
  'model',
  'serviceTier',
  'effort',
  'summary',
  'personality',
  'outputSchema',
  'collaborationMode',
] as const

interface PendingServerRequest {
  readonly id: string
  readonly method: ServerRequest['method']
  readonly params: ServerRequest['params']
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

interface ConversationTurn {
  readonly params: Record<string, unknown>
  readonly turnId: string
  readonly turnStartedAtMs: number | null
  readonly durationMs: number | null
  readonly finalAssistantStartedAtMs: number | null
  readonly status: Turn['status']
  readonly error: Turn['error']
  readonly diff: null
  readonly items: readonly unknown[]
}

interface ConversationState {
  readonly id: string
  readonly forkedFromId: string | null
  readonly hostId: string
  readonly turns: readonly ConversationTurn[]
  readonly requests: readonly Record<string, unknown>[]
  readonly createdAt: number
  readonly updatedAt: number
  readonly title: string | null
  readonly modelProvider: string
  readonly latestModel: string
  readonly latestReasoningEffort: ThreadResumeResponse['reasoningEffort']
  readonly previousTurnModel: null
  readonly latestCollaborationMode: {
    readonly mode: 'default'
    readonly settings: {
      readonly model: string
      readonly reasoning_effort: ThreadResumeResponse['reasoningEffort']
      readonly developer_instructions: null
    }
  }
  readonly hasUnreadTurn: false
  readonly rolloutPath: string
  readonly cwd: string
  readonly gitInfo: Thread['gitInfo']
  readonly resumeState: 'resumed'
  readonly latestTokenUsageInfo: null
  readonly threadDetailLevel: null
  readonly threadRuntimeStatus: ThreadStatus
  readonly turnsPagination: {
    readonly olderCursor: null
    readonly isLoadingOlder: false
    readonly hasLoadedOldest: true
  }
  readonly workspaceKind: 'project'
  readonly source: Thread['source']
}

type ClientRequestMethod = ClientRequest['method']

export function isCodexFollowerIpcMethod(method: string): boolean {
  return FOLLOWER_METHODS.has(method)
}

export class CodexIpcBridge {
  private ipcClient: CodexUiIpcClient | null = null
  private appClient: CodexWsClient | null = null
  private appThread: ThreadResumeResponse | null = null
  private activeThreadId: string | null = null
  private snapshotTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>()

  constructor(private readonly opts: {
    readonly name: string
    readonly env: NodeJS.ProcessEnv
  }) {}

  async run(): Promise<void> {
    while (daemonAlive(this.opts.name)) {
      try {
        await this.runOneIpcConnection()
      } catch (e) {
        this.log(`IPC bridge cycle failed: ${errorMessage(e)}`)
      } finally {
        this.ipcClient?.close()
        this.ipcClient = null
      }
      await sleep(CODEX_IPC_RETRY_MS)
    }
    this.closeAppClient()
  }

  private async runOneIpcConnection(): Promise<void> {
    if (!codexUiIpcSocketExists(this.opts.env)) {
      await sleep(CODEX_IPC_RETRY_MS)
      return
    }
    const socketPath = codexUiIpcSocketPath(this.opts.env)
    const client = new CodexUiIpcClient({
      socketPath,
      clientType: 'claudemux-codex-teammate',
      canHandle: async (ctx) => this.canHandleIpcRequest(ctx.method, ctx.params),
      handleRequest: async (ctx) => this.handleIpcRequest(ctx),
    })
    client.onBroadcast((ctx) => this.handleIpcBroadcast(ctx))
    await client.connect()
    this.ipcClient = client
    this.log(`connected to Codex UI IPC as ${client.id ?? '<unknown>'}`)
    await this.reconcileThread()
    await this.broadcastSnapshot()

    const poll = setInterval(() => {
      this.poll().catch((e) => this.log(`poll failed: ${errorMessage(e)}`))
    }, CODEX_IPC_POLL_MS)
    try {
      await client.closed()
    } finally {
      clearInterval(poll)
    }
  }

  private async poll(): Promise<void> {
    if (!daemonAlive(this.opts.name)) {
      this.ipcClient?.close()
      this.closeAppClient()
      return
    }
    const previousThreadId = this.activeThreadId
    await this.reconcileThread()
    if (this.activeThreadId !== null && this.activeThreadId !== previousThreadId) {
      await this.broadcastSnapshot()
    }
  }

  private async reconcileThread(): Promise<string | null> {
    const state = readDaemonState(this.opts.name)
    if (state === null || !daemonAlive(this.opts.name)) return null
    if (state.threadId === null) return null
    if (this.appClient === null || this.activeThreadId !== state.threadId) {
      await this.openAppClient(state.socketPath, state.threadId)
    }
    return state.threadId
  }

  private async openAppClient(socketPath: string, threadId: string): Promise<void> {
    this.closeAppClient()
    const client = new CodexWsClient({ socketPath })
    await client.ready()
    await client.request<'initialize', InitializeResponse>('initialize', {
      clientInfo: CODEX_CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    })
    client.onClose((reason) => this.handleAppClientClosed(client, reason))
    client.setServerRequestHandler(async (req) => this.handleCodexServerRequest(req))
    client.onNotification((notif) => this.handleCodexNotification(notif))
    this.appClient = client
    this.appThread = await client.request<'thread/resume', ThreadResumeResponse>('thread/resume', {
      threadId,
      persistExtendedHistory: false,
    })
    this.activeThreadId = threadId
  }

  private closeAppClient(): void {
    const client = this.appClient
    this.appClient = null
    this.appThread = null
    this.activeThreadId = null
    if (client !== null) client.close()
    for (const pending of this.pendingServerRequests.values()) {
      pending.reject(new Error('codex IPC bridge app-server connection closed'))
    }
    this.pendingServerRequests.clear()
  }

  private handleAppClientClosed(client: CodexWsClient, reason: Error): void {
    if (this.appClient !== client) return
    this.appClient = null
    this.appThread = null
    this.activeThreadId = null
    for (const pending of this.pendingServerRequests.values()) pending.reject(reason)
    this.pendingServerRequests.clear()
  }

  private handleCodexNotification(notif: ServerNotification): void {
    if (!notificationMatchesThread(notif, this.activeThreadId)) return
    this.scheduleSnapshot()
  }

  private async handleCodexServerRequest(req: ServerRequest): Promise<unknown> {
    if (!serverRequestMatchesThread(req, this.activeThreadId)) {
      throw new Error(`server request ${req.method} does not target the active thread`)
    }
    const id = String(req.id)
    return new Promise((resolve, reject) => {
      this.pendingServerRequests.set(id, {
        id,
        method: req.method,
        params: req.params,
        resolve,
        reject,
      })
      this.scheduleSnapshot()
    })
  }

  private handleIpcBroadcast(ctx: IpcBroadcastContext): void {
    if (ctx.method !== 'client-status-changed') return
    const params = asRecord(ctx.params)
    if (params?.['status'] === 'connected' && params['clientId'] !== this.ipcClient?.id) {
      this.scheduleSnapshot()
    }
  }

  private async canHandleIpcRequest(method: string, params: unknown): Promise<boolean> {
    if (!isCodexFollowerIpcMethod(method)) return false
    await this.reconcileThread()
    if (this.activeThreadId === null) return false
    return conversationId(params) === this.activeThreadId
  }

  private async handleIpcRequest(ctx: IpcRequestContext): Promise<unknown> {
    if (!(await this.canHandleIpcRequest(ctx.method, ctx.params))) {
      throw new Error(`claudemux codex teammate cannot handle ${ctx.method}`)
    }
    switch (ctx.method) {
      case 'thread-follower-start-turn':
        return this.handleStartTurn(ctx.params)
      case 'thread-follower-compact-thread':
        return this.handleCompactThread()
      case 'thread-follower-steer-turn':
        return this.handleSteerTurn(ctx.params)
      case 'thread-follower-interrupt-turn':
        return this.handleInterruptTurn(ctx.params)
      case 'thread-follower-set-model-and-reasoning':
        return this.handleThreadSettings(ctx.params, 'model')
      case 'thread-follower-set-collaboration-mode':
        return this.handleThreadSettings(ctx.params, 'collaboration')
      case 'thread-follower-command-approval-decision':
        return this.resolvePendingServerRequest(ctx.params, 'item/commandExecution/requestApproval')
      case 'thread-follower-file-approval-decision':
        return this.resolvePendingServerRequest(ctx.params, 'item/fileChange/requestApproval')
      case 'thread-follower-permissions-request-approval-response':
        return this.resolvePendingServerRequest(ctx.params, 'item/permissions/requestApproval')
      case 'thread-follower-submit-user-input':
        return this.resolvePendingServerRequest(ctx.params, 'item/tool/requestUserInput')
      case 'thread-follower-submit-mcp-server-elicitation-response':
        return this.resolvePendingServerRequest(ctx.params, 'mcpServer/elicitation/request')
      default:
        throw new Error(`unsupported codex follower IPC method: ${ctx.method}`)
    }
  }

  private async handleStartTurn(params: unknown): Promise<TurnStartResponse> {
    const client = await this.requireAppClient()
    const threadId = this.requireThreadId()
    const startParams = turnStartParamsFromFollower(params, threadId)
    const response = await client.request<'turn/start', TurnStartResponse>('turn/start', startParams)
    this.scheduleSnapshot()
    return response
  }

  private async handleCompactThread(): Promise<ThreadCompactStartResponse> {
    const client = await this.requireAppClient()
    const threadId = this.requireThreadId()
    const response = await client.request<'thread/compact/start', ThreadCompactStartResponse>(
      'thread/compact/start',
      { threadId },
    )
    this.scheduleSnapshot()
    return response
  }

  private async handleSteerTurn(params: unknown): Promise<TurnSteerResponse> {
    const client = await this.requireAppClient()
    const threadId = this.requireThreadId()
    const values = asRecord(params)
    if (values === null) throw new Error('thread-follower-steer-turn params must be an object')
    const input = values['input']
    const expectedTurnId = values['expectedTurnId'] ?? values['turnId']
    if (!Array.isArray(input)) throw new Error('thread-follower-steer-turn missing input array')
    if (typeof expectedTurnId !== 'string' || expectedTurnId.length === 0) {
      throw new Error('thread-follower-steer-turn missing expectedTurnId')
    }
    const steerParams: TurnSteerParams = {
      threadId,
      input: input as TurnSteerParams['input'],
      expectedTurnId,
    }
    if ('responsesapiClientMetadata' in values) {
      steerParams.responsesapiClientMetadata = values['responsesapiClientMetadata'] as TurnSteerParams['responsesapiClientMetadata']
    }
    const response = await client.request<'turn/steer', TurnSteerResponse>('turn/steer', steerParams)
    this.scheduleSnapshot()
    return response
  }

  private async handleInterruptTurn(params: unknown): Promise<TurnInterruptResponse> {
    const client = await this.requireAppClient()
    const values = asRecord(params)
    const turnId = values?.['turnId']
    if (typeof turnId !== 'string' || turnId.length === 0) {
      throw new Error('thread-follower-interrupt-turn missing turnId')
    }
    const response = await client.request<'turn/interrupt', TurnInterruptResponse>('turn/interrupt', {
      threadId: this.requireThreadId(),
      turnId,
    })
    this.scheduleSnapshot()
    return response
  }

  private async handleThreadSettings(
    params: unknown,
    mode: 'model' | 'collaboration',
  ): Promise<ThreadSettingsUpdateResponse> {
    const client = await this.requireAppClient()
    const values = asRecord(params)
    if (values === null) throw new Error(`thread-follower-set-${mode} params must be an object`)
    const settings: Record<string, unknown> = { threadId: this.requireThreadId() }
    if (mode === 'model') {
      copyIfPresent(values, settings, 'model')
      if ('reasoningEffort' in values) settings['effort'] = values['reasoningEffort']
      copyIfPresent(values, settings, 'effort')
      copyIfPresent(values, settings, 'summary')
      copyIfPresent(values, settings, 'serviceTier')
      copyIfPresent(values, settings, 'personality')
    } else {
      copyIfPresent(values, settings, 'collaborationMode')
    }
    const response = await client.request<'thread/settings/update', ThreadSettingsUpdateResponse>(
      'thread/settings/update',
      settings as ParametersFor<'thread/settings/update'>,
    )
    this.scheduleSnapshot()
    return response
  }

  private async resolvePendingServerRequest(
    params: unknown,
    expectedMethod: ServerRequest['method'],
  ): Promise<Record<string, unknown>> {
    const values = asRecord(params)
    if (values === null) throw new Error(`params must be an object for ${expectedMethod}`)
    const requestId = values?.['requestId']
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new Error(`missing requestId for ${expectedMethod}`)
    }
    const pending = this.pendingServerRequests.get(requestId)
    if (pending === undefined) throw new Error(`unknown pending server request ${requestId}`)
    if (pending.method !== expectedMethod) {
      throw new Error(`server request ${requestId} is ${pending.method}, not ${expectedMethod}`)
    }
    const result = serverRequestResult(expectedMethod, values)
    this.pendingServerRequests.delete(requestId)
    pending.resolve(result)
    this.scheduleSnapshot()
    return { ok: true }
  }

  private async requireAppClient(): Promise<CodexWsClient> {
    await this.reconcileThread()
    if (this.appClient === null) throw new Error('codex app-server client is not connected')
    return this.appClient
  }

  private requireThreadId(): string {
    if (this.activeThreadId === null) throw new Error('codex teammate has no active thread')
    return this.activeThreadId
  }

  private scheduleSnapshot(): void {
    if (this.ipcClient === null) return
    if (this.snapshotTimer !== null) clearTimeout(this.snapshotTimer)
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null
      this.broadcastSnapshot().catch((e) => this.log(`snapshot broadcast failed: ${errorMessage(e)}`))
    }, CODEX_IPC_SNAPSHOT_DEBOUNCE_MS)
  }

  private async broadcastSnapshot(): Promise<void> {
    const ipc = this.ipcClient
    if (ipc === null) return
    const threadId = await this.reconcileThread()
    if (threadId === null || this.appClient === null || this.appThread === null) return
    let read: ThreadReadResponse
    try {
      read = await this.appClient.request<'thread/read', ThreadReadResponse>('thread/read', {
        threadId,
        includeTurns: true,
      })
    } catch (e) {
      this.closeAppClient()
      throw e
    }
    const state = conversationStateFromThread(this.appThread, read.thread, [
      ...this.pendingServerRequests.values(),
    ])
    ipc.broadcast('thread-stream-state-changed', {
      conversationId: threadId,
      hostId: CODEX_UI_HOST_ID,
      change: {
        type: 'snapshot',
        conversationState: state,
      },
      version: CODEX_UI_STREAM_VERSION,
    })
  }

  private log(message: string): void {
    console.error(`[codex-ipc-bridge:${this.opts.name}] ${message}`)
  }
}

export function conversationStateFromThread(
  resume: ThreadResumeResponse,
  thread: Thread,
  pendingRequests: readonly Pick<PendingServerRequest, 'id' | 'method' | 'params'>[] = [],
): ConversationState {
  const cwd = resume.cwd || thread.cwd || '/'
  const createdAt = secondsToMillis(thread.createdAt)
  const updatedAt = secondsToMillis(thread.updatedAt)
  return {
    id: thread.id,
    forkedFromId: thread.forkedFromId,
    hostId: CODEX_UI_HOST_ID,
    turns: turnsFromThread(thread.id, thread.turns, resume, cwd),
    requests: pendingRequests.map((request) => ({
      id: request.id,
      method: request.method,
      params: request.params,
    })),
    createdAt,
    updatedAt,
    title: thread.name,
    modelProvider: resume.modelProvider || thread.modelProvider,
    latestModel: resume.model,
    latestReasoningEffort: resume.reasoningEffort,
    previousTurnModel: null,
    latestCollaborationMode: {
      mode: 'default',
      settings: {
        model: resume.model,
        reasoning_effort: resume.reasoningEffort,
        developer_instructions: null,
      },
    },
    hasUnreadTurn: false,
    rolloutPath: thread.path ?? '',
    cwd,
    gitInfo: thread.gitInfo,
    resumeState: 'resumed',
    latestTokenUsageInfo: null,
    threadDetailLevel: null,
    threadRuntimeStatus: thread.status,
    turnsPagination: {
      olderCursor: null,
      isLoadingOlder: false,
      hasLoadedOldest: true,
    },
    workspaceKind: 'project',
    source: thread.source,
  }
}

function turnsFromThread(
  threadId: string,
  turns: readonly Turn[],
  resume: ThreadResumeResponse,
  cwd: string,
): readonly ConversationTurn[] {
  return turns.map((turn) => {
    const first = turn.items[0]
    const input = isUserMessageItem(first) ? first.content : []
    return {
      params: {
        threadId,
        input,
        approvalPolicy: resume.approvalPolicy,
        approvalsReviewer: resume.approvalsReviewer,
        sandboxPolicy: resume.sandbox,
        model: resume.model,
        cwd,
        attachments: [],
        effort: resume.reasoningEffort,
        summary: 'none',
        personality: null,
        outputSchema: null,
        collaborationMode: null,
      },
      turnId: turn.id,
      turnStartedAtMs: nullableSecondsToMillis(turn.startedAt),
      durationMs: turn.durationMs,
      finalAssistantStartedAtMs: nullableSecondsToMillis(turn.completedAt),
      status: turn.status,
      error: turn.error,
      diff: null,
      items: turn.items.map((item) => normalizeThreadItemForUi(item)),
    }
  })
}

function normalizeThreadItemForUi(item: unknown): unknown {
  if (
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: unknown }).type === 'collabAgentToolCall' &&
    Array.isArray((item as { receiverThreadIds?: unknown }).receiverThreadIds)
  ) {
    const ids = (item as { receiverThreadIds: readonly unknown[] }).receiverThreadIds
    return {
      ...item,
      receiverThreads: ids
        .filter((id): id is string => typeof id === 'string')
        .map((threadId) => ({ threadId, thread: null })),
    }
  }
  return item
}

export function turnStartParamsFromFollower(params: unknown, threadId: string): TurnStartParams {
  const outer = asRecord(params)
  if (outer === null) throw new Error('thread-follower-start-turn params must be an object')
  const inner = asRecord(outer['turnStartParams']) ?? outer
  const input = inner['input']
  if (!Array.isArray(input)) throw new Error('thread-follower-start-turn missing input array')
  const result: Record<string, unknown> = {
    threadId,
    input,
  }
  for (const key of TURN_START_OPTIONAL_KEYS) copyIfPresent(inner, result, key)
  return result as TurnStartParams
}

function serverRequestResult(
  method: ServerRequest['method'],
  values: Record<string, unknown>,
): unknown {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      if (!('decision' in values)) throw new Error(`missing decision for ${method}`)
      return { decision: values['decision'] }
    case 'item/permissions/requestApproval':
    case 'item/tool/requestUserInput':
    case 'mcpServer/elicitation/request': {
      if (!('response' in values)) throw new Error(`missing response for ${method}`)
      return values['response']
    }
    case 'item/tool/call':
    case 'account/chatgptAuthTokens/refresh':
    case 'attestation/generate':
    case 'applyPatchApproval':
    case 'execCommandApproval':
      throw new Error(`unsupported server request response method: ${method}`)
  }
}

function notificationMatchesThread(notif: ServerNotification, threadId: string | null): boolean {
  if (threadId === null) return false
  const params = asRecord(notif.params)
  if (params === null) return false
  if (params['threadId'] === threadId) return true
  const thread = asRecord(params['thread'])
  return thread?.['id'] === threadId
}

function serverRequestMatchesThread(req: ServerRequest, threadId: string | null): boolean {
  if (threadId === null) return false
  const params = asRecord(req.params)
  return params?.['threadId'] === threadId
}

function conversationId(params: unknown): string | null {
  const record = asRecord(params)
  const id = record?.['conversationId']
  return typeof id === 'string' && id.length > 0 ? id : null
}

function isUserMessageItem(item: unknown): item is { readonly content: readonly unknown[] } {
  return (
    typeof item === 'object' &&
    item !== null &&
    (item as { type?: unknown }).type === 'userMessage' &&
    Array.isArray((item as { content?: unknown }).content)
  )
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function copyIfPresent(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  key: string,
): void {
  if (key in from) to[key] = from[key]
}

function secondsToMillis(value: number): number {
  return Number.isFinite(value) ? value * 1000 : Date.now()
}

function nullableSecondsToMillis(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : value * 1000
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

type ParametersFor<M extends ClientRequestMethod> = Extract<ClientRequest, { method: M }>['params']
