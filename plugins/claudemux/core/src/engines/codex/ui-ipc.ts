import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'

export const CODEX_UI_IPC_VERSION = 0
const INITIALIZING_CLIENT_ID = 'initializing-client'

type PendingResponse = {
  readonly method: string
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

interface IpcRequestEnvelope {
  readonly type: 'request'
  readonly requestId: string
  readonly sourceClientId: string
  readonly targetClientId?: string
  readonly version: number
  readonly method: string
  readonly params?: unknown
}

interface IpcBroadcastEnvelope {
  readonly type: 'broadcast'
  readonly sourceClientId: string
  readonly version: number
  readonly method: string
  readonly params?: unknown
}

interface IpcDiscoveryRequestEnvelope {
  readonly type: 'client-discovery-request'
  readonly requestId: string
  readonly sourceClientId: string
  readonly version?: number
  readonly method: string
  readonly params?: unknown
}

type IpcIncomingEnvelope =
  | IpcRequestEnvelope
  | IpcBroadcastEnvelope
  | IpcDiscoveryRequestEnvelope
  | {
      readonly type: 'response'
      readonly requestId: string
      readonly resultType: 'success'
      readonly handledByClientId?: string
      readonly method?: string
      readonly result?: unknown
    }
  | {
      readonly type: 'response'
      readonly requestId: string
      readonly resultType: 'error'
      readonly handledByClientId?: string
      readonly method?: string
      readonly error?: unknown
    }

export interface IpcRequestContext {
  readonly requestId: string
  readonly sourceClientId: string
  readonly method: string
  readonly params: unknown
}

export interface IpcBroadcastContext {
  readonly sourceClientId: string
  readonly method: string
  readonly params: unknown
}

export type IpcRequestHandler = (ctx: IpcRequestContext) => Promise<unknown>
export type IpcCanHandle = (ctx: Omit<IpcRequestContext, 'requestId'>) => Promise<boolean>
export type IpcBroadcastHandler = (ctx: IpcBroadcastContext) => void

export function codexUiIpcSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return join(env['TMPDIR'] ?? '/tmp', 'codex-ipc', `ipc-${uid}.sock`)
}

export function codexUiIpcSocketExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(codexUiIpcSocketPath(env))
}

export class CodexUiIpcClient {
  private socket: Socket | null = null
  private buffer = Buffer.alloc(0)
  private readonly pending = new Map<string, PendingResponse>()
  private readonly broadcastHandlers: IpcBroadcastHandler[] = []
  private closedPromise: Promise<void> | null = null
  private closeResolve: (() => void) | null = null
  private clientId: string | null = null

  constructor(private readonly opts: {
    readonly socketPath: string
    readonly clientType: string
    readonly canHandle: IpcCanHandle
    readonly handleRequest: IpcRequestHandler
  }) {}

  get id(): string | null {
    return this.clientId
  }

  async connect(): Promise<string> {
    if (this.socket !== null) throw new Error('CodexUiIpcClient already connected')
    this.closedPromise = new Promise<void>((resolve) => {
      this.closeResolve = resolve
    })
    const socket = createConnection(this.opts.socketPath)
    this.socket = socket
    socket.on('data', (chunk) => this.onData(chunk))
    socket.once('close', () => this.onClose(new Error('codex UI IPC socket closed')))
    socket.once('error', (e) => this.onClose(e instanceof Error ? e : new Error(String(e))))
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('error', (e) => reject(e instanceof Error ? e : new Error(String(e))))
    })
    const result = await this.request('initialize', { clientType: this.opts.clientType }, {
      sourceClientId: INITIALIZING_CLIENT_ID,
    })
    const clientId = extractClientId(result)
    if (clientId === null) throw new Error('codex UI IPC initialize response did not include clientId')
    this.clientId = clientId
    return clientId
  }

  onBroadcast(handler: IpcBroadcastHandler): void {
    this.broadcastHandlers.push(handler)
  }

  async request(
    method: string,
    params: unknown,
    options: { readonly targetClientId?: string; readonly sourceClientId?: string } = {},
  ): Promise<unknown> {
    const socket = this.socket
    if (socket === null) throw new Error('codex UI IPC client is not connected')
    const requestId = randomUUID()
    const sourceClientId = options.sourceClientId ?? this.requireClientId()
    const envelope: IpcRequestEnvelope = {
      type: 'request',
      requestId,
      sourceClientId,
      version: CODEX_UI_IPC_VERSION,
      method,
      params,
      ...(options.targetClientId === undefined ? {} : { targetClientId: options.targetClientId }),
    }
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { method, resolve, reject })
      try {
        this.send(envelope)
      } catch (e) {
        this.pending.delete(requestId)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  broadcast(method: string, params: unknown): void {
    this.send({
      type: 'broadcast',
      sourceClientId: this.requireClientId(),
      version: CODEX_UI_IPC_VERSION,
      method,
      params,
    })
  }

  close(): void {
    if (this.socket === null) return
    this.socket.destroy()
    this.onClose(new Error('codex UI IPC client closed by caller'))
  }

  closed(): Promise<void> {
    return this.closedPromise ?? Promise.resolve()
  }

  private requireClientId(): string {
    if (this.clientId === null) throw new Error('codex UI IPC client is not initialized')
    return this.clientId
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 4) {
      const payloadLength = this.buffer.readUInt32LE(0)
      if (this.buffer.length < payloadLength + 4) return
      const payload = this.buffer.subarray(4, payloadLength + 4)
      this.buffer = this.buffer.subarray(payloadLength + 4)
      this.onEnvelope(payload)
    }
  }

  private onEnvelope(payload: Buffer): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(payload.toString('utf8'))
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const env = parsed as Partial<IpcIncomingEnvelope>
    switch (env.type) {
      case 'response':
        this.onResponse(env as IpcIncomingEnvelope)
        break
      case 'broadcast':
        this.onBroadcastEnvelope(env as IpcBroadcastEnvelope)
        break
      case 'client-discovery-request':
        this.onDiscoveryRequest(env as IpcDiscoveryRequestEnvelope).catch(() => {})
        break
      case 'request':
        this.onRequestEnvelope(env as IpcRequestEnvelope).catch(() => {})
        break
    }
  }

  private onResponse(env: IpcIncomingEnvelope): void {
    if (env.type !== 'response') return
    const pending = this.pending.get(env.requestId)
    if (pending === undefined) return
    this.pending.delete(env.requestId)
    if (env.resultType === 'success') {
      pending.resolve(env.result)
      return
    }
    pending.reject(new Error(errorMessage(env.error) ?? `codex UI IPC request ${pending.method} failed`))
  }

  private onBroadcastEnvelope(env: IpcBroadcastEnvelope): void {
    for (const handler of this.broadcastHandlers) {
      try {
        handler({
          sourceClientId: env.sourceClientId,
          method: env.method,
          params: env.params,
        })
      } catch {
        // Broadcast handlers are observers; one bad observer must not close the IPC link.
      }
    }
  }

  private async onDiscoveryRequest(env: IpcDiscoveryRequestEnvelope): Promise<void> {
    const canHandle = await this.opts.canHandle({
      sourceClientId: env.sourceClientId,
      method: env.method,
      params: env.params,
    })
    this.send({
      type: 'client-discovery-response',
      requestId: env.requestId,
      sourceClientId: this.requireClientId(),
      version: CODEX_UI_IPC_VERSION,
      canHandle,
    })
  }

  private async onRequestEnvelope(env: IpcRequestEnvelope): Promise<void> {
    try {
      const result = await this.opts.handleRequest({
        requestId: env.requestId,
        sourceClientId: env.sourceClientId,
        method: env.method,
        params: env.params,
      })
      this.send({
        type: 'response',
        requestId: env.requestId,
        sourceClientId: this.requireClientId(),
        handledByClientId: this.requireClientId(),
        version: CODEX_UI_IPC_VERSION,
        resultType: 'success',
        method: env.method,
        result,
      })
    } catch (e) {
      this.send({
        type: 'response',
        requestId: env.requestId,
        sourceClientId: this.requireClientId(),
        handledByClientId: this.requireClientId(),
        version: CODEX_UI_IPC_VERSION,
        resultType: 'error',
        method: env.method,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }

  private send(envelope: unknown): void {
    const socket = this.socket
    if (socket === null) throw new Error('codex UI IPC client is not connected')
    const payload = Buffer.from(JSON.stringify(envelope), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(payload.length, 0)
    socket.write(Buffer.concat([header, payload]))
  }

  private onClose(reason: Error): void {
    if (this.socket === null) return
    this.socket = null
    this.clientId = null
    this.buffer = Buffer.alloc(0)
    for (const pending of this.pending.values()) pending.reject(reason)
    this.pending.clear()
    this.closeResolve?.()
    this.closeResolve = null
  }
}

function extractClientId(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null
  const clientId = (result as { clientId?: unknown }).clientId
  return typeof clientId === 'string' && clientId.length > 0 ? clientId : null
}

function errorMessage(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (typeof value !== 'object' || value === null) return null
  const message = (value as { message?: unknown }).message
  return typeof message === 'string' ? message : null
}
