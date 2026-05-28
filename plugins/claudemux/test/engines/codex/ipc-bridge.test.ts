import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { ThreadResumeResponse } from '../../../src/codex-protocol/v2/ThreadResumeResponse'
import type { Thread } from '../../../src/codex-protocol/v2/Thread'
import type { IpcBroadcastContext } from '../../../src/engines/codex/ui-ipc'
import {
  CodexIpcBridge,
  conversationStateFromThread,
  isCodexFollowerIpcMethod,
  turnInterruptParamsFromFollower,
  turnStartParamsFromFollower,
  turnSteerParamsFromFollower,
} from '../../../src/engines/codex/ipc-bridge'
import { CodexUiIpcClient, codexUiIpcSocketPath } from '../../../src/engines/codex/ui-ipc'

type PendingServerRequestForTest = {
  readonly id: string
  readonly method: string
  readonly params: unknown
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

type MockAppClient = {
  request: ReturnType<typeof vi.fn>
}

type BridgeInternals = {
  ipcClient: {
    readonly id: string | null
    broadcast?(method: string, params: unknown): void
  } | null
  appClient: MockAppClient | null
  activeThreadId: string | null
  pendingServerRequests: Map<string, PendingServerRequestForTest>
  handleIpcBroadcast(ctx: IpcBroadcastContext): void
  handleInterruptTurn(params: unknown): Promise<Record<string, unknown>>
  handleSteerTurn(params: unknown): Promise<Record<string, unknown>>
  handleSetQueuedFollowUpsState(params: unknown): Promise<Record<string, unknown>>
  resolvePendingServerRequest(params: unknown, method: string): Promise<Record<string, unknown>>
  resolvePendingServerRequestsForInterrupt(): number
  scheduleSnapshot(): void
}

type UiIpcClientInternals = {
  onDiscoveryRequest(env: unknown): Promise<void>
  onEnvelope(payload: Buffer): void
  send(envelope: unknown): void
}

let tempDirs: string[] = []
let servers: Server[] = []
let consoleErrorSpy: ReturnType<typeof vi.spyOn>
let previousDebugIpc: string | undefined

beforeEach(() => {
  previousDebugIpc = process.env['CLAUDEMUX_DEBUG_IPC']
  delete process.env['CLAUDEMUX_DEBUG_IPC']
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  consoleErrorSpy.mockRestore()
  if (previousDebugIpc === undefined) delete process.env['CLAUDEMUX_DEBUG_IPC']
  else process.env['CLAUDEMUX_DEBUG_IPC'] = previousDebugIpc
  for (const server of servers) await closeServer(server)
  servers = []
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs = []
})

function sampleThread(): Thread {
  return {
    id: '019e5f5f-2e57-7abc-8def-123456789abc',
    sessionId: 'session-1',
    forkedFromId: null,
    preview: 'hello',
    ephemeral: false,
    modelProvider: 'openai',
    createdAt: 1,
    updatedAt: 2,
    status: { type: 'idle' },
    path: '/tmp/rollout.jsonl',
    cwd: '/repo',
    cliVersion: 'codex-test',
    source: 'appServer',
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: 'test title',
    turns: [
      {
        id: 'turn-1',
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: 1,
        completedAt: 2,
        durationMs: 1000,
        items: [
          {
            type: 'userMessage',
            id: 'user-1',
            content: [{ type: 'text', text: 'hello', text_elements: [] }],
          },
          {
            type: 'agentMessage',
            id: 'agent-1',
            text: 'hi',
            phase: null,
            memoryCitation: null,
          },
        ],
      },
    ],
  }
}

function sampleTurn(id: string, status: Thread['turns'][number]['status']): Thread['turns'][number] {
  const base = sampleThread().turns[0]
  if (base === undefined) throw new Error('sample thread has no turns')
  return {
    ...base,
    id,
    status,
    completedAt: status === 'inProgress' ? null : base.completedAt,
  }
}

function sampleThreadWithTurns(turns: Thread['turns']): Thread {
  return {
    ...sampleThread(),
    turns,
  }
}

function sampleResume(thread: Thread): ThreadResumeResponse {
  return {
    thread,
    model: 'gpt-5',
    modelProvider: 'openai',
    serviceTier: null,
    cwd: '/repo',
    runtimeWorkspaceRoots: ['/repo'],
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    activePermissionProfile: null,
    reasoningEffort: null,
  }
}

function makeBridgeInternals(): BridgeInternals {
  return new CodexIpcBridge({ name: 'codex/ipc-test', env: {} }) as unknown as BridgeInternals
}

function frame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

function parseFrames(
  chunk: Buffer,
  state: { buffer: Buffer },
  onFrame: (value: Record<string, unknown>) => void,
): void {
  state.buffer = Buffer.concat([state.buffer, chunk])
  while (state.buffer.length >= 4) {
    const len = state.buffer.readUInt32LE(0)
    if (state.buffer.length < len + 4) return
    const payload = state.buffer.subarray(4, len + 4)
    state.buffer = state.buffer.subarray(len + 4)
    onFrame(JSON.parse(payload.toString('utf8')) as Record<string, unknown>)
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error('waitFor timed out'))
        return
      }
      setTimeout(tick, 10)
    }
    tick()
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err === undefined) resolve()
      else if ((err as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve()
      else reject(err)
    })
  })
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
}

describe.skip('codex UI IPC bridge', () => {
  test('builds the same socket path shape used by Codex.app and VS Code', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0
    expect(codexUiIpcSocketPath({ TMPDIR: '/tmp/codex-ui-test/' })).toBe(
      join('/tmp/codex-ui-test/', 'codex-ipc', `ipc-${uid}.sock`),
    )
  })

  test('advertises only follower methods the bridge can proxy', () => {
    expect(isCodexFollowerIpcMethod('thread-follower-start-turn')).toBe(true)
    expect(isCodexFollowerIpcMethod('thread-follower-steer-turn')).toBe(true)
    expect(isCodexFollowerIpcMethod('thread-follower-interrupt-turn')).toBe(true)
    expect(isCodexFollowerIpcMethod('thread-follower-set-queued-follow-ups-state')).toBe(true)
    expect(isCodexFollowerIpcMethod('thread-follower-submit-user-input')).toBe(true)
    expect(isCodexFollowerIpcMethod('thread-stream-state-changed')).toBe(false)
  })

  test('answers Codex router discovery requests with the nested response shape', async () => {
    const sent: unknown[] = []
    const canHandle = vi.fn(async () => true)
    const client = new CodexUiIpcClient({
      socketPath: '/unused.sock',
      clientType: 'test-client',
      canHandle,
      handleRequest: async () => ({}),
    }) as unknown as UiIpcClientInternals
    client.send = (envelope) => {
      sent.push(envelope)
    }

    // Protocol source: /Applications/Codex.app/Contents/Resources/app.asar,
    // .vite/build/workspace-root-drop-handler-DJwLZgXt.js line 669.
    // sendClientDiscoveryRequest builds { type, requestId, request }, and
    // handleClientDiscoveryRequest reads the method version from request.version.
    await client.onDiscoveryRequest({
      type: 'client-discovery-request',
      requestId: 'discovery-1',
      request: {
        type: 'request',
        requestId: 'request-original',
        sourceClientId: 'router',
        version: 1,
        method: 'thread-follower-interrupt-turn',
        params: { conversationId: 'thread-1' },
      },
    })

    expect(canHandle).toHaveBeenCalledWith({
      sourceClientId: 'router',
      method: 'thread-follower-interrupt-turn',
      params: { conversationId: 'thread-1' },
    })
    expect(sent).toEqual([{
      type: 'client-discovery-response',
      requestId: 'discovery-1',
      response: { canHandle: true },
    }])

    sent.length = 0
    canHandle.mockClear()
    await client.onDiscoveryRequest({
      type: 'client-discovery-request',
      requestId: 'discovery-2',
      request: {
        type: 'request',
        requestId: 'request-original',
        sourceClientId: 'router',
        version: 0,
        method: 'thread-follower-interrupt-turn',
        params: { conversationId: 'thread-1' },
      },
    })

    expect(canHandle).not.toHaveBeenCalled()
    expect(sent).toEqual([{
      type: 'client-discovery-response',
      requestId: 'discovery-2',
      response: { canHandle: false },
    }])
  })

  test('gates raw inbound IPC frame logging behind CLAUDEMUX_DEBUG_IPC', () => {
    const client = new CodexUiIpcClient({
      socketPath: '/unused.sock',
      clientType: 'test-client',
      canHandle: async () => false,
      handleRequest: async () => ({}),
    }) as unknown as UiIpcClientInternals
    const payload = Buffer.from(JSON.stringify({
      type: 'broadcast',
      sourceClientId: 'other-client',
      version: 0,
      method: 'client-status-changed',
      params: { clientId: 'other-client', status: 'connected' },
    }), 'utf8')

    client.onEnvelope(payload)
    expect(consoleErrorSpy).not.toHaveBeenCalled()

    process.env['CLAUDEMUX_DEBUG_IPC'] = '1'
    client.onEnvelope(payload)
    expect(consoleErrorSpy.mock.calls.some(([message]) =>
      String(message).startsWith('[codex-ui-ipc] inbound '),
    )).toBe(true)
  })

  test('converts a codex thread/read snapshot into the UI stream snapshot shape', () => {
    const thread = sampleThread()
    const state = conversationStateFromThread(sampleResume(thread), thread, [
      {
        id: 'request-1',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: thread.id,
          turnId: 'turn-1',
          itemId: 'tool-1',
          questions: [],
        },
      },
    ])

    expect(state).toMatchObject({
      id: thread.id,
      hostId: 'local',
      title: 'test title',
      latestModel: 'gpt-5',
      cwd: '/repo',
      rolloutPath: '/tmp/rollout.jsonl',
      resumeState: 'resumed',
      workspaceKind: 'project',
      createdAt: 1000,
      updatedAt: 2000,
    })
    expect(state.turns[0]?.params.input).toEqual([{ type: 'text', text: 'hello', text_elements: [] }])
    expect(state.turns[0]?.items).toHaveLength(2)
    expect(state.requests).toEqual([
      {
        id: 'request-1',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: thread.id,
          turnId: 'turn-1',
          itemId: 'tool-1',
          questions: [],
        },
      },
    ])
  })

  test('parses length-prefixed IPC frames across empty frames, half frames, and sticky packets', async () => {
    const dir = mkdtempSync('/tmp/cmxipc-')
    tempDirs.push(dir)
    const socketPath = join(dir, 'ipc.sock')
    const server = createServer((socket: Socket) => {
      const parser = { buffer: Buffer.alloc(0) }
      socket.on('data', (chunk) => {
        parseFrames(chunk, parser, (env) => {
          if (env['method'] !== 'initialize') return
          const response = frame({
            type: 'response',
            requestId: env['requestId'],
            resultType: 'success',
            method: 'initialize',
            result: { clientId: 'client-1' },
          })
          const stickyBroadcasts = Buffer.concat([
            frame({
              type: 'broadcast',
              sourceClientId: 'other-client',
              version: 0,
              method: 'client-status-changed',
              params: { clientId: 'other-client', status: 'connected' },
            }),
            frame({
              type: 'broadcast',
              sourceClientId: 'other-client',
              version: 0,
              method: 'thread-read-state-changed',
              params: { conversationId: 'thread-1', hasUnreadTurn: false },
            }),
          ])
          socket.write(Buffer.alloc(4))
          socket.write(response.subarray(0, 3))
          setTimeout(() => socket.write(Buffer.concat([response.subarray(3), stickyBroadcasts])), 0)
        })
      })
    })
    servers.push(server)
    await listen(server, socketPath)

    const broadcasts: IpcBroadcastContext[] = []
    const client = new CodexUiIpcClient({
      socketPath,
      clientType: 'test-client',
      canHandle: async () => false,
      handleRequest: async () => ({}),
    })
    client.onBroadcast((ctx) => broadcasts.push(ctx))

    await expect(client.connect()).resolves.toBe('client-1')
    await waitFor(() => broadcasts.length === 2)
    expect(broadcasts.map((ctx) => ctx.method)).toEqual([
      'client-status-changed',
      'thread-read-state-changed',
    ])
    client.close()
  })

  test('uses Codex method versions on discovery and follower request responses', async () => {
    const dir = mkdtempSync('/tmp/cmxipc-')
    tempDirs.push(dir)
    const socketPath = join(dir, 'ipc.sock')
    const received: Record<string, unknown>[] = []
    let connectedSocket: Socket | null = null
    const server = createServer((socket: Socket) => {
      connectedSocket = socket
      const parser = { buffer: Buffer.alloc(0) }
      socket.on('data', (chunk) => {
        parseFrames(chunk, parser, (env) => {
          received.push(env)
          if (env['method'] !== 'initialize') return
          socket.write(frame({
            type: 'response',
            requestId: env['requestId'],
            resultType: 'success',
            method: 'initialize',
            result: { clientId: 'client-1' },
          }))
        })
      })
    })
    servers.push(server)
    await listen(server, socketPath)

    const client = new CodexUiIpcClient({
      socketPath,
      clientType: 'test-client',
      canHandle: async (ctx) => ctx.method === 'thread-follower-interrupt-turn',
      handleRequest: async () => ({ ok: true }),
    })

    await expect(client.connect()).resolves.toBe('client-1')
    const socket = connectedSocket as Socket | null
    if (socket === null) throw new Error('test server did not accept a socket')
    // Protocol source: /Applications/Codex.app/Contents/Resources/app.asar,
    // .vite/build/workspace-root-drop-handler-DJwLZgXt.js line 669.
    // The router wraps the original request under request and does not copy
    // method version to the discovery envelope top level.
    socket.write(frame({
      type: 'client-discovery-request',
      requestId: 'discovery-1',
      request: {
        type: 'request',
        requestId: 'request-original',
        sourceClientId: 'router',
        version: 1,
        method: 'thread-follower-interrupt-turn',
        params: { conversationId: 'thread-1' },
      },
    }))
    socket.write(frame({
      type: 'request',
      requestId: 'request-1',
      sourceClientId: 'router',
      version: 1,
      method: 'thread-follower-interrupt-turn',
      params: { conversationId: 'thread-1' },
    }))

    await waitFor(() =>
      received.some((env) => env['type'] === 'client-discovery-response') &&
      received.some((env) => env['type'] === 'response' && env['requestId'] === 'request-1'),
    )
    expect(received.find((env) => env['type'] === 'client-discovery-response')).toMatchObject({
      type: 'client-discovery-response',
      requestId: 'discovery-1',
      response: { canHandle: true },
    })
    expect(received.find((env) => env['type'] === 'response' && env['requestId'] === 'request-1')).toMatchObject({
      type: 'response',
      requestId: 'request-1',
      method: 'thread-follower-interrupt-turn',
      version: 1,
      resultType: 'success',
      result: { ok: true },
    })
    client.close()
  })

  test('uses Codex method versions on outgoing stream broadcasts', async () => {
    const dir = mkdtempSync('/tmp/cmxipc-')
    tempDirs.push(dir)
    const socketPath = join(dir, 'ipc.sock')
    const received: Record<string, unknown>[] = []
    const server = createServer((socket: Socket) => {
      const parser = { buffer: Buffer.alloc(0) }
      socket.on('data', (chunk) => {
        parseFrames(chunk, parser, (env) => {
          received.push(env)
          if (env['method'] !== 'initialize') return
          socket.write(frame({
            type: 'response',
            requestId: env['requestId'],
            resultType: 'success',
            method: 'initialize',
            result: { clientId: 'client-1' },
          }))
        })
      })
    })
    servers.push(server)
    await listen(server, socketPath)

    const client = new CodexUiIpcClient({
      socketPath,
      clientType: 'test-client',
      canHandle: async () => false,
      handleRequest: async () => ({}),
    })

    await expect(client.connect()).resolves.toBe('client-1')
    client.broadcast('thread-stream-state-changed', {
      conversationId: 'thread-1',
      hostId: 'local',
      change: { type: 'snapshot', conversationState: {} },
      version: 6,
    })
    client.broadcast('thread-queued-followups-changed', {
      conversationId: 'thread-1',
      messages: [],
    })

    await waitFor(() => received.filter((env) => env['type'] === 'broadcast').length === 2)
    expect(received.find((env) => env['method'] === 'thread-stream-state-changed')).toMatchObject({
      type: 'broadcast',
      method: 'thread-stream-state-changed',
      version: 6,
    })
    expect(received.find((env) => env['method'] === 'thread-queued-followups-changed')).toMatchObject({
      type: 'broadcast',
      method: 'thread-queued-followups-changed',
      version: 1,
    })
    client.close()
  })

  test('rebroadcasts snapshots when a new UI client connects', () => {
    const bridge = makeBridgeInternals()
    bridge.ipcClient = { id: 'bridge-client' }
    let scheduled = 0
    bridge.scheduleSnapshot = () => {
      scheduled += 1
    }

    bridge.handleIpcBroadcast({
      sourceClientId: 'router',
      method: 'client-status-changed',
      params: { clientId: 'new-client', status: 'connected' },
    })
    bridge.handleIpcBroadcast({
      sourceClientId: 'router',
      method: 'client-status-changed',
      params: { clientId: 'bridge-client', status: 'connected' },
    })
    bridge.handleIpcBroadcast({
      sourceClientId: 'router',
      method: 'client-status-changed',
      params: { clientId: 'new-client', status: 'disconnected' },
    })
    bridge.handleIpcBroadcast({
      sourceClientId: 'router',
      method: 'thread-read-state-changed',
      params: { clientId: 'new-client', status: 'connected' },
    })

    expect(scheduled).toBe(1)
  })

  test('maps follower start-turn params onto codex turn/start params', () => {
    expect(turnStartParamsFromFollower({
      conversationId: 'ui-thread',
      turnStartParams: {
        threadId: 'ui-thread',
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
        cwd: '/repo',
        model: 'gpt-5',
        effort: 'medium',
        summary: 'auto',
        approvalPolicy: 'never',
        approvalsReviewer: 'user',
        sandboxPolicy: { type: 'dangerFullAccess' },
        responsesapiClientMetadata: { source: 'desktop' },
        collaborationMode: null,
      },
    }, 'actual-thread')).toEqual({
      threadId: 'actual-thread',
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      cwd: '/repo',
      model: 'gpt-5',
      effort: 'medium',
      summary: 'auto',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'dangerFullAccess' },
      responsesapiClientMetadata: { source: 'desktop' },
      collaborationMode: null,
    })
  })

  test('maps follower steer-turn params onto codex turn/steer params', () => {
    const input = [{ type: 'text', text: 'follow up', text_elements: [] }]
    expect(turnSteerParamsFromFollower({
      conversationId: 'ui-thread',
      input,
      restoreMessage: {
        responsesapiClientMetadata: { source: 'desktop' },
      },
    }, 'actual-thread', 'turn-1')).toEqual({
      threadId: 'actual-thread',
      input,
      expectedTurnId: 'turn-1',
      responsesapiClientMetadata: { source: 'desktop' },
    })
    expect(turnSteerParamsFromFollower({
      conversationId: 'ui-thread',
      turnSteerParams: {
        input,
        expectedTurnId: 'turn-2',
        responsesapiClientMetadata: null,
      },
    }, 'actual-thread', 'turn-1')).toEqual({
      threadId: 'actual-thread',
      input,
      expectedTurnId: 'turn-2',
      responsesapiClientMetadata: null,
    })
    expect(() => turnSteerParamsFromFollower({
      conversationId: 'ui-thread',
      input,
    }, 'actual-thread')).toThrow('missing active turn id')
  })

  test('maps follower interrupt params onto codex turn/interrupt params', () => {
    expect(turnInterruptParamsFromFollower({
      conversationId: 'ui-thread',
    }, 'actual-thread', 'turn-1')).toEqual({
      threadId: 'actual-thread',
      turnId: 'turn-1',
    })
    expect(turnInterruptParamsFromFollower({
      conversationId: 'ui-thread',
      turnInterruptParams: { turnId: 'turn-2' },
    }, 'actual-thread', 'turn-1')).toEqual({
      threadId: 'actual-thread',
      turnId: 'turn-2',
    })
    expect(() => turnInterruptParamsFromFollower({
      conversationId: 'ui-thread',
    }, 'actual-thread')).toThrow('missing active turn id')
  })

  test('retries follower steer when app-server reports the current active turn id', async () => {
    const bridge = makeBridgeInternals()
    const input = [{ type: 'text', text: 'follow up', text_elements: [] }]
    const request = vi.fn()
      .mockResolvedValueOnce({ thread: sampleThreadWithTurns([sampleTurn('turn-1', 'inProgress')]) })
      .mockRejectedValueOnce(new Error('expected active turn id `turn-1` but found `turn-2`'))
      .mockResolvedValueOnce({ turnId: 'turn-2' })
    bridge.appClient = { request }
    bridge.activeThreadId = 'thread-1'
    bridge.scheduleSnapshot = vi.fn()

    await expect(bridge.handleSteerTurn({
      conversationId: 'thread-1',
      input,
    })).resolves.toEqual({ result: { turnId: 'turn-2' } })
    expect(request).toHaveBeenNthCalledWith(1, 'thread/read', {
      threadId: 'thread-1',
      includeTurns: true,
    })
    expect(request).toHaveBeenNthCalledWith(2, 'turn/steer', {
      threadId: 'thread-1',
      input,
      expectedTurnId: 'turn-1',
    })
    expect(request).toHaveBeenNthCalledWith(3, 'turn/steer', {
      threadId: 'thread-1',
      input,
      expectedTurnId: 'turn-2',
    })
    expect(bridge.scheduleSnapshot).toHaveBeenCalledTimes(1)
  })

  test('fails follower steer without retry when app-server error does not include an active turn id', async () => {
    const bridge = makeBridgeInternals()
    const input = [{ type: 'text', text: 'follow up', text_elements: [] }]
    const request = vi.fn()
      .mockResolvedValueOnce({ thread: sampleThreadWithTurns([sampleTurn('turn-1', 'inProgress')]) })
      .mockRejectedValueOnce(new Error('turn/steer failed with an unstructured error'))
    bridge.appClient = { request }
    bridge.activeThreadId = 'thread-1'
    bridge.scheduleSnapshot = vi.fn()

    await expect(bridge.handleSteerTurn({
      conversationId: 'thread-1',
      input,
    })).rejects.toThrow('turn/steer failed with an unstructured error')
    expect(request).toHaveBeenCalledTimes(2)
    expect(bridge.scheduleSnapshot).not.toHaveBeenCalled()
  })

  test('treats follower interrupt with no active turn as an idempotent no-op', async () => {
    const bridge = makeBridgeInternals()
    const request = vi.fn()
      .mockResolvedValueOnce({ thread: sampleThreadWithTurns([sampleTurn('turn-1', 'completed')]) })
    bridge.appClient = { request }
    bridge.activeThreadId = 'thread-1'
    bridge.scheduleSnapshot = vi.fn()

    await expect(bridge.handleInterruptTurn({
      conversationId: 'thread-1',
    })).resolves.toEqual({ ok: true })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('thread/read', {
      threadId: 'thread-1',
      includeTurns: true,
    })
    expect(bridge.scheduleSnapshot).toHaveBeenCalledTimes(1)
  })

  test('broadcasts queued follow-up state changes to connected UI clients', async () => {
    const bridge = makeBridgeInternals()
    const broadcasts: { method: string; params: unknown }[] = []
    bridge.activeThreadId = 'thread-1'
    bridge.ipcClient = {
      id: 'bridge-client',
      broadcast: (method, params) => {
        broadcasts.push({ method, params })
      },
    }
    const message = { id: 'message-1', text: 'next', createdAt: 1 }

    await expect(bridge.handleSetQueuedFollowUpsState({
      conversationId: 'thread-1',
      state: { 'thread-1': [message] },
    })).resolves.toEqual({ ok: true })
    expect(broadcasts).toEqual([
      {
        method: 'thread-queued-followups-changed',
        params: {
          conversationId: 'thread-1',
          messages: [message],
        },
      },
    ])
  })

  test('resolves pending approval and input requests with explicit error paths', async () => {
    const bridge = makeBridgeInternals()

    await expect(
      bridge.resolvePendingServerRequest(null, 'item/commandExecution/requestApproval'),
    ).rejects.toThrow('params must be an object')
    await expect(
      bridge.resolvePendingServerRequest({ requestId: '' }, 'item/commandExecution/requestApproval'),
    ).rejects.toThrow('missing requestId')
    await expect(
      bridge.resolvePendingServerRequest({ requestId: 'missing' }, 'item/commandExecution/requestApproval'),
    ).rejects.toThrow('unknown pending server request missing')

    const commandResolve = vi.fn()
    bridge.pendingServerRequests.set('command-1', {
      id: 'command-1',
      method: 'item/commandExecution/requestApproval',
      params: {},
      resolve: commandResolve,
      reject: vi.fn(),
    })
    await expect(
      bridge.resolvePendingServerRequest({ requestId: 'command-1', decision: 'approved' }, 'item/fileChange/requestApproval'),
    ).rejects.toThrow('is item/commandExecution/requestApproval')
    await expect(
      bridge.resolvePendingServerRequest({ requestId: 'command-1' }, 'item/commandExecution/requestApproval'),
    ).rejects.toThrow('missing decision')
    await expect(
      bridge.resolvePendingServerRequest({ requestId: 'command-1', decision: 'approved' }, 'item/commandExecution/requestApproval'),
    ).resolves.toEqual({ ok: true })
    expect(commandResolve).toHaveBeenCalledWith({ decision: 'approved' })

    const inputResolve = vi.fn()
    bridge.pendingServerRequests.set('input-1', {
      id: 'input-1',
      method: 'item/tool/requestUserInput',
      params: {},
      resolve: inputResolve,
      reject: vi.fn(),
    })
    await expect(
      bridge.resolvePendingServerRequest({ requestId: 'input-1' }, 'item/tool/requestUserInput'),
    ).rejects.toThrow('missing response')
    await expect(
      bridge.resolvePendingServerRequest({
        requestId: 'input-1',
        response: { answers: { question: { answers: ['yes'] } } },
      }, 'item/tool/requestUserInput'),
    ).resolves.toEqual({ ok: true })
    expect(inputResolve).toHaveBeenCalledWith({ answers: { question: { answers: ['yes'] } } })
  })

  test('declines pending approval and input requests before interrupting a turn', () => {
    const bridge = makeBridgeInternals()
    const commandResolve = vi.fn()
    const permissionResolve = vi.fn()
    const inputResolve = vi.fn()
    const elicitationResolve = vi.fn()
    bridge.pendingServerRequests.set('command-1', {
      id: 'command-1',
      method: 'item/commandExecution/requestApproval',
      params: {},
      resolve: commandResolve,
      reject: vi.fn(),
    })
    bridge.pendingServerRequests.set('permission-1', {
      id: 'permission-1',
      method: 'item/permissions/requestApproval',
      params: {},
      resolve: permissionResolve,
      reject: vi.fn(),
    })
    bridge.pendingServerRequests.set('input-1', {
      id: 'input-1',
      method: 'item/tool/requestUserInput',
      params: {},
      resolve: inputResolve,
      reject: vi.fn(),
    })
    bridge.pendingServerRequests.set('elicitation-1', {
      id: 'elicitation-1',
      method: 'mcpServer/elicitation/request',
      params: {},
      resolve: elicitationResolve,
      reject: vi.fn(),
    })

    expect(bridge.resolvePendingServerRequestsForInterrupt()).toBe(4)
    expect(commandResolve).toHaveBeenCalledWith({ decision: 'decline' })
    expect(permissionResolve).toHaveBeenCalledWith({ permissions: {}, scope: 'turn' })
    expect(inputResolve).toHaveBeenCalledWith({ answers: {} })
    expect(elicitationResolve).toHaveBeenCalledWith({ action: 'decline', content: null, _meta: null })
    expect(bridge.pendingServerRequests.size).toBe(0)
  })
})
