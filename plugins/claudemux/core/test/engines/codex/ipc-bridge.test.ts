import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import type { ThreadResumeResponse } from '../../../src/codex-protocol/v2/ThreadResumeResponse'
import type { Thread } from '../../../src/codex-protocol/v2/Thread'
import type { IpcBroadcastContext } from '../../../src/engines/codex/ui-ipc'
import {
  CodexIpcBridge,
  conversationStateFromThread,
  isCodexFollowerIpcMethod,
  turnStartParamsFromFollower,
} from '../../../src/engines/codex/ipc-bridge'
import { CodexUiIpcClient, codexUiIpcSocketPath } from '../../../src/engines/codex/ui-ipc'

type PendingServerRequestForTest = {
  readonly id: string
  readonly method: string
  readonly params: unknown
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

type BridgeInternals = {
  ipcClient: { readonly id: string | null } | null
  pendingServerRequests: Map<string, PendingServerRequestForTest>
  handleIpcBroadcast(ctx: IpcBroadcastContext): void
  resolvePendingServerRequest(params: unknown, method: string): Promise<Record<string, unknown>>
  scheduleSnapshot(): void
}

let tempDirs: string[] = []
let servers: Server[] = []

afterEach(async () => {
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

describe('codex UI IPC bridge', () => {
  test('builds the same socket path shape used by Codex.app and VS Code', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 0
    expect(codexUiIpcSocketPath({ TMPDIR: '/tmp/codex-ui-test/' })).toBe(
      join('/tmp/codex-ui-test/', 'codex-ipc', `ipc-${uid}.sock`),
    )
  })

  test('advertises only follower methods the bridge can proxy', () => {
    expect(isCodexFollowerIpcMethod('thread-follower-start-turn')).toBe(true)
    expect(isCodexFollowerIpcMethod('thread-follower-submit-user-input')).toBe(true)
    expect(isCodexFollowerIpcMethod('thread-stream-state-changed')).toBe(false)
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
})
