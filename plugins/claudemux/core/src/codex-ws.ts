/**
 * The codex app-server WebSocket JSON-RPC client.
 *
 * Decision 0019 §5: claudemux spawns `codex app-server --listen unix://<path>`
 * itself, detached, and connects to it from each `tm` invocation that targets
 * a codex teammate. This module is the connection.
 *
 * The wire envelope codex emits is *not* strict JSON-RPC 2.0 — the
 * `jsonrpc` version field is omitted. The shape is pinned by
 * `test/codex-schema.test.ts` against a captured fixture; this client
 * matches that pin character for character:
 *
 *   - client request   : { method, id, params }
 *   - response (ok)    : { id, result }
 *   - response (error) : { id, error: { code?, message, data? } }
 *   - notification     : { method, params }                       (no id)
 *   - server-request   : { method, id, params }                   (id present)
 *
 * The router dispatches incoming frames by structural probe rather than by a
 * version-field discriminant — `method+id+params` is a request, `method+params`
 * alone is a notification, `id+result|error` is a response. A frame that
 * carries neither `method` nor `id` is a protocol violation and tears the
 * connection down.
 */

import WebSocket, { type RawData } from 'ws'

import type { ClientRequest, ServerNotification, ServerRequest } from './codex-protocol/index.js'

interface RequestEnvelope {
  method: string
  id: number
  params: unknown
}

interface OkResponseEnvelope {
  id: number
  result: unknown
}

interface ErrResponseEnvelope {
  id: number
  error: { code?: number; message: string; data?: unknown }
}

type ResponseEnvelope = OkResponseEnvelope | ErrResponseEnvelope

interface NotificationEnvelope {
  method: string
  params: unknown
}

interface ServerRequestEnvelope {
  method: string
  id: number
  params: unknown
}

type IncomingEnvelope =
  | ResponseEnvelope
  | NotificationEnvelope
  | ServerRequestEnvelope

/** Extract the `params` shape of a vendored client request by its method. */
type ParamsFor<M extends ClientRequest['method']> = Extract<
  ClientRequest,
  { method: M }
>['params']

export interface CodexWsClientOptions {
  /**
   * Unix socket path the codex daemon listens on. The production transport
   * per decision 0019: claudemux spawns `codex app-server --listen unix://<path>`
   * and the client connects to the same path. The `ws` npm package routes
   * the WebSocket upgrade through a unix-domain socket connection when the
   * URL uses the `ws+unix://` scheme.
   */
  socketPath?: string
  /**
   * A `ws://...` URL. Used by the unit tests to point the client at an
   * in-process `WebSocket.Server` listening on a TCP loopback port. The
   * codex daemon itself can also be `--listen ws://127.0.0.1:<port>` (a
   * non-loopback listener would require `--ws-auth`); production picks
   * `socketPath` for filesystem-permission scoping.
   */
  url?: string
}

export type NotificationHandler = (notif: ServerNotification) => void
export type ServerRequestHandler = (req: ServerRequest) => Promise<unknown>

/**
 * A long-running websocket connection to one `codex app-server` daemon.
 * Stateless across `tm` invocations — the daemon survives, the client is
 * recreated each call.
 */
export class CodexWsClient {
  private readonly ws: WebSocket
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >()
  private readonly notifHandlers: NotificationHandler[] = []
  private serverReqHandler: ServerRequestHandler = async () => null
  private nextId = 1
  private readonly opened: Promise<void>
  private closed = false
  private closeReason: Error | null = null

  constructor(opts: CodexWsClientOptions) {
    // `perMessageDeflate: false` is load-bearing. The codex app-server's
    // WebSocket upgrade is strict about the `Sec-WebSocket-Extensions`
    // header — the `ws` library's default
    // `permessage-deflate; client_max_window_bits` proposal makes
    // tokio-tungstenite (on the daemon's side) reject the upgrade with
    // `Missing, duplicated or incorrect header sec-websocket-extensions`,
    // and the client sees only a bare "socket hang up" with no stderr
    // line on the daemon unless RUST_LOG is on. Verified empirically
    // against codex 0.133.0; disabling the extension makes the upgrade
    // complete and JSON-RPC traffic begin.
    const wsOpts = { perMessageDeflate: false }
    if (opts.socketPath !== undefined) {
      this.ws = new WebSocket(`ws+unix://${opts.socketPath}`, wsOpts)
    } else if (opts.url !== undefined) {
      this.ws = new WebSocket(opts.url, wsOpts)
    } else {
      throw new Error('CodexWsClient: socketPath or url required')
    }

    this.opened = new Promise<void>((res, rej) => {
      this.ws.once('open', () => res())
      this.ws.once('error', (e) => rej(e instanceof Error ? e : new Error(String(e))))
    })

    this.ws.on('message', (data) => this.onFrame(data))
    this.ws.on('close', () =>
      this.tearDown(new Error('codex daemon closed the connection')),
    )
    this.ws.on('error', (e) =>
      this.tearDown(e instanceof Error ? e : new Error(String(e))),
    )
  }

  /** Resolve once the WebSocket open handshake completes. */
  ready(): Promise<void> {
    return this.opened
  }

  /** Subscribe to a server-pushed notification stream — `turn/completed`, etc. */
  onNotification(handler: NotificationHandler): void {
    this.notifHandlers.push(handler)
  }

  /**
   * Install the handler for server→client requests. The daemon issues these
   * when it wants the client to confirm a tool call, supply user input, or
   * generate an attestation; an `approval_policy: Never` codex teammate
   * largely suppresses them but cannot eliminate every one. The handler's
   * return value becomes the response envelope's `result`; a throw becomes
   * the response envelope's `error.message`.
   *
   * Without an explicit handler the daemon's request resolves to `null`,
   * which keeps the teammate from blocking but is rarely the right answer
   * for anything substantive. Set one before driving real turns.
   */
  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverReqHandler = handler
  }

  /**
   * Send a client request and wait for the matching response envelope. The
   * caller passes the response type as the second generic so the return is
   * typed — codex's generated bindings do not emit a top-level response
   * union, so the client takes the expected `R` as a hint rather than
   * inferring it.
   */
  request<M extends ClientRequest['method'], R = unknown>(
    method: M,
    params: ParamsFor<M>,
  ): Promise<R> {
    if (this.closed) {
      return Promise.reject(this.closeReason ?? new Error('codex client closed'))
    }
    const id = this.nextId++
    const envelope: RequestEnvelope = { method, id, params }
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      })
      try {
        this.ws.send(JSON.stringify(envelope))
      } catch (e) {
        this.pending.delete(id)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  /** Tear down. Pending requests reject with the caller's reason. */
  close(): void {
    this.tearDown(new Error('codex client closed by caller'))
    this.ws.close()
  }

  private onFrame(data: RawData): void {
    let parsed: unknown
    try {
      const text = typeof data === 'string' ? data : data.toString('utf8')
      parsed = JSON.parse(text)
    } catch (e) {
      this.tearDown(
        new Error(
          `codex daemon sent a non-JSON frame: ${(e as Error).message}`,
        ),
      )
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.tearDown(
        new Error('codex daemon sent a non-object envelope'),
      )
      return
    }
    const env = parsed as Record<string, unknown>

    const hasMethod = typeof env['method'] === 'string'
    const hasId = typeof env['id'] === 'number'
    const hasResult = 'result' in env
    const hasError = 'error' in env

    if (hasMethod && hasId) {
      // `.catch` on the floating promise: handleServerRequest is async
      // and posts via `this.ws.send`, which can synchronously throw if
      // the socket is in CLOSING/CLOSED at the moment the reply lands.
      // Without a .catch the rejection escapes as `unhandledRejection`,
      // which Node 22 currently warns about and future versions exit on.
      // Tearing the connection down on a failed reply is the correct
      // disposition — there is no useful retry from here.
      this.handleServerRequest(env as unknown as ServerRequestEnvelope).catch(
        (err) =>
          this.tearDown(
            err instanceof Error ? err : new Error(String(err)),
          ),
      )
    } else if (hasMethod) {
      this.dispatchNotification(env as unknown as ServerNotification)
    } else if (hasId && (hasResult || hasError)) {
      this.handleResponse(env as unknown as ResponseEnvelope)
    } else {
      this.tearDown(
        new Error('codex daemon sent envelope with neither id nor method'),
      )
    }
  }

  private handleResponse(env: ResponseEnvelope): void {
    const pending = this.pending.get(env.id)
    if (pending === undefined) return
    this.pending.delete(env.id)
    if ('error' in env) {
      pending.reject(new Error(env.error.message))
    } else {
      pending.resolve(env.result)
    }
  }

  private dispatchNotification(notif: ServerNotification): void {
    for (const h of this.notifHandlers) {
      try {
        h(notif)
      } catch {
        // A handler's throw must not poison the loop. The daemon does not
        // care that a client-side listener crashed.
      }
    }
  }

  private async handleServerRequest(env: ServerRequestEnvelope): Promise<void> {
    const req = env as unknown as ServerRequest
    try {
      const result = await this.serverReqHandler(req)
      const reply: OkResponseEnvelope = { id: env.id, result }
      this.ws.send(JSON.stringify(reply))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const reply: ErrResponseEnvelope = { id: env.id, error: { message } }
      this.ws.send(JSON.stringify(reply))
    }
  }

  private tearDown(reason: Error): void {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    for (const { reject } of this.pending.values()) reject(reason)
    this.pending.clear()
  }
}
