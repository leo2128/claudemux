/**
 * Unit tests for `CodexWsClient` — the envelope routing and lifecycle.
 *
 * A real `codex app-server` cannot run in CI (no codex install, no auth);
 * the client's protocol-layer behaviour is exercised here against an
 * in-process `WebSocket.Server` that replays the four envelope shapes
 * the codex daemon actually emits.
 *
 * The captured-fixture pin lives in `codex-schema.test.ts`; this file
 * pins the router around it — every distinct envelope ends up on the
 * right handler, malformed envelopes tear the connection down, and
 * `close()` rejects every in-flight request.
 */

import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { WebSocketServer } from '#ws'
import type { WebSocket as WsServerSocket } from '#ws'

import { CodexWsClient } from '../src/engines/codex/rpc'
import type { InitializeResponse } from '../src/codex-protocol/InitializeResponse'

interface Harness {
  server: WebSocketServer
  url: string
  serverSocket: Promise<WsServerSocket>
}

async function startHarness(): Promise<Harness> {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise<void>((res) => server.once('listening', () => res()))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  const serverSocket = new Promise<WsServerSocket>((resolve) => {
    server.once('connection', (sock) => resolve(sock))
  })
  return { server, url, serverSocket }
}

let harness: Harness
let client: CodexWsClient | undefined

beforeEach(async () => {
  harness = await startHarness()
  client = undefined
})

afterEach(async () => {
  if (client !== undefined) client.close()
  await new Promise<void>((res) => harness.server.close(() => res()))
})

describe('CodexWsClient — request/response routing', () => {
  test('a {id, result} envelope resolves the matching request', async () => {
    client = new CodexWsClient({ url: harness.url })
    await client.ready()
    const sock = await harness.serverSocket
    sock.on('message', (data) => {
      const env = JSON.parse(data.toString())
      // Echo back an InitializeResponse-shaped result with no `jsonrpc`
      // field — the envelope shape the schema test pins.
      sock.send(
        JSON.stringify({
          id: env.id,
          result: {
            userAgent: 'fake-codex/0.0',
            codexHome: '/tmp/codex-home',
            platformFamily: 'unix',
            platformOs: 'linux',
          },
        }),
      )
    })

    const resp = await client.request<'initialize', InitializeResponse>(
      'initialize',
      {
        clientInfo: { name: 'test', title: null, version: '0.0.0' },
        capabilities: null,
      },
    )

    expect(resp.userAgent).toBe('fake-codex/0.0')
    expect(resp.platformOs).toBe('linux')
  })

  test('a {id, error} envelope rejects the matching request with the error message', async () => {
    client = new CodexWsClient({ url: harness.url })
    await client.ready()
    const sock = await harness.serverSocket
    sock.on('message', (data) => {
      const env = JSON.parse(data.toString())
      sock.send(
        JSON.stringify({
          id: env.id,
          error: { code: -32601, message: 'no such method' },
        }),
      )
    })

    await expect(
      client.request('initialize', {
        clientInfo: { name: 't', title: null, version: '0' },
        capabilities: null,
      }),
    ).rejects.toThrow('no such method')
  })

  test('two requests get their own ids and resolve independently of order', async () => {
    client = new CodexWsClient({ url: harness.url })
    await client.ready()
    const sock = await harness.serverSocket
    const seen: number[] = []
    sock.on('message', (data) => {
      const env = JSON.parse(data.toString())
      seen.push(env.id)
      // Reply to the *second* request first; the client must still pair
      // each response with the right pending promise by `id`.
      if (seen.length === 2) {
        sock.send(JSON.stringify({ id: seen[1], result: { tag: 'second' } }))
        sock.send(JSON.stringify({ id: seen[0], result: { tag: 'first' } }))
      }
    })

    const [a, b] = await Promise.all([
      client.request<'initialize', { tag: string }>('initialize', {
        clientInfo: { name: 'a', title: null, version: '0' },
        capabilities: null,
      }),
      client.request<'initialize', { tag: string }>('initialize', {
        clientInfo: { name: 'b', title: null, version: '0' },
        capabilities: null,
      }),
    ])
    expect(a.tag).toBe('first')
    expect(b.tag).toBe('second')
  })
})

describe('CodexWsClient — notifications and server-requests', () => {
  test('a {method, params} envelope (no id) fans out to every subscriber', async () => {
    client = new CodexWsClient({ url: harness.url })
    await client.ready()
    const sock = await harness.serverSocket

    const seen: string[] = []
    client.onNotification((notif) => seen.push(`a:${notif.method}`))
    client.onNotification((notif) => seen.push(`b:${notif.method}`))

    sock.send(JSON.stringify({ method: 'turn/started', params: { threadId: 't', turn: { id: 'x' } } }))
    sock.send(JSON.stringify({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'x' } } }))

    await new Promise((res) => setTimeout(res, 10))
    expect(seen).toEqual([
      'a:turn/started',
      'b:turn/started',
      'a:turn/completed',
      'b:turn/completed',
    ])
  })

  test('a server-request gets a response back from the installed handler', async () => {
    client = new CodexWsClient({ url: harness.url })
    await client.ready()
    const sock = await harness.serverSocket

    client.setServerRequestHandler(async (req) => {
      // `applyPatchApproval` is a real server-request method in the vendored bindings.
      if (req.method === 'applyPatchApproval') return { decision: 'denied' }
      return null
    })

    const replyReceived = new Promise<unknown>((resolve) => {
      sock.on('message', (data) => {
        const env = JSON.parse(data.toString())
        if ('result' in env || 'error' in env) resolve(env)
      })
    })

    sock.send(
      JSON.stringify({
        method: 'applyPatchApproval',
        id: 42,
        params: { conversationId: 'c', callId: 'k', fileChanges: {}, reason: null, grantRoot: null },
      }),
    )

    const reply = (await replyReceived) as { id: number; result: { decision: string } }
    expect(reply.id).toBe(42)
    expect(reply.result.decision).toBe('denied')
  })

  test('a server-request handler that throws yields an error response back', async () => {
    client = new CodexWsClient({ url: harness.url })
    await client.ready()
    const sock = await harness.serverSocket

    client.setServerRequestHandler(async () => {
      throw new Error('the handler said no')
    })

    const replyReceived = new Promise<unknown>((resolve) => {
      sock.on('message', (data) => {
        const env = JSON.parse(data.toString())
        if ('result' in env || 'error' in env) resolve(env)
      })
    })

    sock.send(
      JSON.stringify({
        method: 'attestation/generate',
        id: 99,
        params: { nonce: 'n' },
      }),
    )

    const reply = (await replyReceived) as { id: number; error: { message: string } }
    expect(reply.id).toBe(99)
    expect(reply.error.message).toBe('the handler said no')
  })
})

describe('CodexWsClient — close and protocol-violation tear-down', () => {
  test('close() rejects every in-flight request', async () => {
    client = new CodexWsClient({ url: harness.url })
    await client.ready()
    await harness.serverSocket

    const inFlight = client.request('initialize', {
      clientInfo: { name: 't', title: null, version: '0' },
      capabilities: null,
    })
    client.close()
    await expect(inFlight).rejects.toThrow('closed')
  })

  test('a malformed (non-JSON) frame tears the connection down and rejects pending', async () => {
    client = new CodexWsClient({ url: harness.url })
    await client.ready()
    const sock = await harness.serverSocket

    const inFlight = client.request('initialize', {
      clientInfo: { name: 't', title: null, version: '0' },
      capabilities: null,
    })
    sock.send('this is not json')
    await expect(inFlight).rejects.toThrow(/non-JSON|closed/)
  })

  test('an envelope with neither id nor method tears down', async () => {
    client = new CodexWsClient({ url: harness.url })
    await client.ready()
    const sock = await harness.serverSocket

    const inFlight = client.request('initialize', {
      clientInfo: { name: 't', title: null, version: '0' },
      capabilities: null,
    })
    sock.send(JSON.stringify({ result: 'orphan' }))
    await expect(inFlight).rejects.toThrow(/neither id nor method|closed/)
  })
})
