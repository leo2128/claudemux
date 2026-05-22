/**
 * An MCP transport over a unix-domain socket connection.
 *
 * The core is resident and serves many short-lived dispatcher connections, so
 * its outward face cannot be the per-process stdio transport feishu-channel
 * uses — that one is owned by the process that launched it. Instead the core
 * listens on a unix socket (`paths.coreSocketPath`); `server.ts` accepts each
 * connection and pairs it with one of these transports and a fresh MCP
 * `Server`.
 *
 * The wire framing is the same newline-delimited JSON-RPC the SDK's stdio
 * transport uses — `ReadBuffer` and `serializeMessage` are reused so this
 * transport only has to bridge those to a `net.Socket`.
 */

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Socket } from 'node:net'

/** One MCP connection, carried over an accepted unix-socket connection. */
export class SocketServerTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void
  onclose?: () => void
  onerror?: (error: Error) => void

  readonly #socket: Socket
  readonly #readBuffer = new ReadBuffer()
  #started = false
  #closed = false

  constructor(socket: Socket) {
    this.#socket = socket
  }

  /** Begin draining the socket. The MCP `Server` calls this via `connect`. */
  async start(): Promise<void> {
    if (this.#started) throw new Error('SocketServerTransport already started')
    this.#started = true
    this.#socket.on('data', (chunk: Buffer) => {
      this.#readBuffer.append(chunk)
      this.#drain()
    })
    this.#socket.on('error', (err) => this.onerror?.(err))
    this.#socket.on('close', () => this.#emitClose())
  }

  /** Write one JSON-RPC message, newline-framed, to the socket. */
  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#socket.write(serializeMessage(message), (err) =>
        err ? reject(err) : resolve(),
      )
    })
  }

  /** Close the underlying socket. */
  async close(): Promise<void> {
    this.#socket.end()
    // The socket's own `close` event also calls `#emitClose`; the guard there
    // makes `onclose` fire exactly once. Calling it here too means a caller
    // that closes the transport sees `onclose` without waiting for the async
    // socket event, matching the SDK's stdio transport.
    this.#emitClose()
  }

  /** Fire `onclose` exactly once, whichever of `close()` or the socket wins. */
  #emitClose(): void {
    if (this.#closed) return
    this.#closed = true
    this.onclose?.()
  }

  /** Pull every complete message the read buffer now holds. */
  #drain(): void {
    for (;;) {
      let message: JSONRPCMessage | null
      try {
        message = this.#readBuffer.readMessage()
      } catch (err) {
        // `readMessage` consumes the offending line before it throws, so the
        // next iteration parses the following message — one malformed frame
        // must not strand the valid frames already buffered behind it.
        this.onerror?.(err instanceof Error ? err : new Error(String(err)))
        continue
      }
      if (message === null) return
      this.onmessage?.(message)
    }
  }
}
