/**
 * The unix-socket MCP transport bridges a `net.Socket` to the SDK's
 * newline-delimited JSON-RPC framing. These tests drive it against a fake
 * socket: an `EventEmitter` with `write`/`end`, which is the whole surface
 * `SocketServerTransport` touches.
 */

import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'

import { SocketServerTransport } from '../src/socket-transport'

/** A minimal stand-in for a net.Socket — just what the transport calls. */
class FakeSocket extends EventEmitter {
  written: string[] = []
  ended = false
  write(data: string | Buffer, cb?: (err?: Error) => void): boolean {
    this.written.push(data.toString())
    cb?.()
    return true
  }
  end(): this {
    this.ended = true
    return this
  }
}

/** Newline-frame a JSON-RPC message the way the SDK's stdio framing does. */
function frame(message: unknown): string {
  return `${JSON.stringify(message)}\n`
}

describe('SocketServerTransport', () => {
  test('a malformed frame does not strand the valid frames buffered behind it', async () => {
    const socket = new FakeSocket()
    const transport = new SocketServerTransport(socket as unknown as Socket)
    const received: unknown[] = []
    const errors: Error[] = []
    transport.onmessage = (m) => received.push(m)
    transport.onerror = (e) => errors.push(e)
    await transport.start()

    const valid = { jsonrpc: '2.0', id: 1, method: 'ping' }
    // One data chunk: a malformed line, then a valid message behind it.
    socket.emit('data', Buffer.from(`{not json\n${frame(valid)}`))

    expect(errors).toHaveLength(1)
    expect(received).toEqual([valid])
  })

  test('a message split across two data chunks is reassembled', async () => {
    const socket = new FakeSocket()
    const transport = new SocketServerTransport(socket as unknown as Socket)
    const received: unknown[] = []
    transport.onmessage = (m) => received.push(m)
    await transport.start()

    const message = { jsonrpc: '2.0', id: 2, method: 'ping' }
    const wire = frame(message)
    socket.emit('data', Buffer.from(wire.slice(0, 6)))
    socket.emit('data', Buffer.from(wire.slice(6)))
    expect(received).toEqual([message])
  })

  test('onclose fires exactly once across close() and the socket close event', async () => {
    const socket = new FakeSocket()
    const transport = new SocketServerTransport(socket as unknown as Socket)
    let closes = 0
    transport.onclose = () => {
      closes += 1
    }
    await transport.start()

    await transport.close()
    socket.emit('close') // the real socket also emits this after end()
    expect(closes).toBe(1)
  })

  test('send writes one newline-framed message', async () => {
    const socket = new FakeSocket()
    const transport = new SocketServerTransport(socket as unknown as Socket)
    await transport.start()

    await transport.send({ jsonrpc: '2.0', id: 3, result: {} })
    expect(socket.written).toHaveLength(1)
    const line = socket.written[0]
    expect(line?.endsWith('\n')).toBe(true)
    expect(JSON.parse((line ?? '').trim())).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
  })

  test('start twice is rejected', async () => {
    const transport = new SocketServerTransport(new FakeSocket() as unknown as Socket)
    await transport.start()
    expect(transport.start()).rejects.toThrow('already started')
  })
})
