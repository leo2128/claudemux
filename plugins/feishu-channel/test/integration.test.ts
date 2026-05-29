/**
 * Assembly-layer integration tests.
 *
 * The unit suites prove each module's logic in isolation. These tests prove
 * the wiring: the channel core, a fake Feishu transport, and a fake MCP server
 * are connected exactly as `main` connects the real ones, then an inbound
 * event and a tool call are driven end to end — covering "inbound event →
 * `notifications/claude/channel`" and "tool call → outbound Feishu send"
 * without a live connection on either side.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveAccess } from '../src/access-store'
import { IM_MESSAGE_EVENT_TYPE } from '../src/handlers/im-message'
import { channelNotification, createChannelCore, RECEIVED_REACTION_EMOJIS } from '../src/server'
import type { Access } from '../src/types'
import { FakeTransport } from './support/fake-transport'

const NOW = 1_700_000_000_000

/**
 * A stand-in for the MCP `Server`, recording every notification the channel
 * pushes. The real `main` wires `notify` to `server.notification(...)`; this
 * captures the same calls so the assembly is exercised without stdio.
 */
class FakeMcpServer {
  readonly notifications: { method: string; params: unknown }[] = []
  notification(note: { method: string; params: unknown }): void {
    this.notifications.push(note)
  }
}

let dir: string
let accessFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'feishu-integration-'))
  accessFile = join(dir, 'access.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeAccess(overrides: Partial<Access>): void {
  saveAccess(accessFile, {
    dmPolicy: 'pairing',
    groupPolicy: 'allowlist',
    allowFrom: [],
    groups: {},
    pending: {},
    ...overrides,
  })
}

/** A raw `im.message.receive_v1` event body from a fixed test sender. */
function rawImEvent(): Record<string, unknown> {
  return {
    sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
    message: {
      message_id: 'om_msg',
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      message_type: 'text',
      content: '{"text":"hello there"}',
      mentions: [],
    },
  }
}

/** Wire a channel core to fakes exactly as `main` wires the real resources. */
function assemble(transport: FakeTransport): { server: FakeMcpServer; core: ReturnType<typeof createChannelCore> } {
  const server = new FakeMcpServer()
  const core = createChannelCore({
    transport,
    accessFile,
    notify: (content, meta) => {
      server.notification(channelNotification(content, meta))
    },
    now: () => NOW,
    generateCode: () => 'abc123',
  })
  return { server, core }
}

describe('integration — inbound event to channel notification', () => {
  test('a gated-in event reaches the MCP server as a channel notification', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const { server, core } = assemble(new FakeTransport())

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())

    expect(server.notifications).toHaveLength(1)
    expect(server.notifications[0]?.method).toBe('notifications/claude/channel')
    expect(server.notifications[0]?.params).toEqual({
      content: 'hello there',
      meta: {
        kind: 'message',
        chat_id: 'oc_chat',
        message_id: 'om_msg',
        chat_type: 'p2p',
        sender_id: 'ou_sender',
      },
    })
  })

  test('a route callback dispatches the same way handleEvent does', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const { server, core } = assemble(new FakeTransport())

    await core.routes[IM_MESSAGE_EVENT_TYPE]?.(rawImEvent())

    expect(server.notifications).toHaveLength(1)
  })

  test('an event gated out by access control produces no notification', async () => {
    // Default pairing policy, unknown sender → the channel replies with a
    // pairing code and delivers nothing into the session.
    writeAccess({ dmPolicy: 'pairing' })
    const transport = new FakeTransport()
    const { server, core } = assemble(transport)

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())

    expect(server.notifications).toHaveLength(0)
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.text).toContain('abc123')
  })
})

describe('integration — tool call to outbound send', () => {
  test('a reply tool call reaches the transport as an outbound send', async () => {
    const transport = new FakeTransport()
    const { core } = assemble(transport)

    const result = await core.handleTool('reply', { chat_id: 'oc_chat', text: 'answer' })

    expect(result.isError).toBeUndefined()
    expect(transport.sent).toEqual([{ chatId: 'oc_chat', text: 'answer' }])
  })

  test('the tool list the core advertises matches the tools it can execute', async () => {
    const { core } = assemble(new FakeTransport())

    for (const tool of core.tools) {
      const result = await core.handleTool(tool.name, {})
      // An empty argument set is rejected for a missing argument — but never
      // as an "unknown tool", which is what an advertised-but-unhandled tool
      // would produce.
      expect(JSON.stringify(result.content)).not.toContain('Unknown tool')
    }
  })
})

describe('integration — received-reaction indicator', () => {
  test('an inbound message is reacted to, and a reply takes the reaction back off', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    const { server, core } = assemble(transport)

    // Inbound: the event reaches the session, then the source message is
    // marked as received.
    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())
    expect(server.notifications).toHaveLength(1)
    expect(transport.reactions).toHaveLength(1)
    const reaction = transport.reactions[0]!
    expect(reaction.messageId).toBe('om_msg')
    expect(RECEIVED_REACTION_EMOJIS as readonly string[]).toContain(reaction.emoji)

    // Reply: answering the chat takes the indicator off the message.
    await core.handleTool('reply', { chat_id: 'oc_chat', text: 'answer' })
    expect(transport.reactionRemovals).toEqual([
      { messageId: 'om_msg', reactionId: 'rk_om_msg' },
    ])
  })
})
