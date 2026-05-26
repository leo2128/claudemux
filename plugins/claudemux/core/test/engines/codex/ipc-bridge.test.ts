import { join } from 'node:path'

import { describe, expect, test } from 'vitest'

import type { ThreadResumeResponse } from '../../../src/codex-protocol/v2/ThreadResumeResponse'
import type { Thread } from '../../../src/codex-protocol/v2/Thread'
import { conversationStateFromThread, isCodexFollowerIpcMethod } from '../../../src/engines/codex/ipc-bridge'
import { codexUiIpcSocketPath } from '../../../src/engines/codex/ui-ipc'

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
})
