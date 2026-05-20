import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAccess, saveAccess } from '../src/access-store'
import type { FeishuInboundEvent, FeishuTransport } from '../src/feishu'
import { createChannelCore } from '../src/server'
import type { Access } from '../src/types'

const NOW = 1_700_000_000_000

/** A fake transport that records every outbound call and can be told to fail. */
class FakeTransport implements FeishuTransport {
  botOpenId: string | undefined
  readonly sent: { chatId: string; text: string }[] = []
  readonly reactions: { messageId: string; emoji: string }[] = []
  readonly edits: { messageId: string; text: string }[] = []
  /** When set, the named method throws — used to test outbound failure paths. */
  failOn: 'sendText' | 'addReaction' | 'editText' | undefined

  constructor(botOpenId?: string) {
    this.botOpenId = botOpenId
  }

  async start(): Promise<void> {}

  async sendText(chatId: string, text: string): Promise<{ messageId?: string }> {
    if (this.failOn === 'sendText') throw new Error('feishu send failed')
    this.sent.push({ chatId, text })
    return { messageId: 'om_sent' }
  }

  async addReaction(messageId: string, emoji: string): Promise<void> {
    if (this.failOn === 'addReaction') throw new Error('feishu reaction failed')
    this.reactions.push({ messageId, emoji })
  }

  async editText(messageId: string, text: string): Promise<void> {
    if (this.failOn === 'editText') throw new Error('feishu edit failed')
    this.edits.push({ messageId, text })
  }

  async close(): Promise<void> {}
}

interface Note {
  content: string
  meta: Record<string, string>
}

let dir: string
let accessFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'feishu-server-'))
  accessFile = join(dir, 'access.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Build a channel core wired to fakes, capturing every notification in `notes`. */
function makeCore(
  transport: FakeTransport,
  notes: Note[],
  logErrors: string[] = [],
  notify?: (content: string, meta: Record<string, string>) => void,
) {
  return createChannelCore({
    transport,
    accessFile,
    notify:
      notify ??
      ((content, meta) => {
        notes.push({ content, meta })
      }),
    now: () => NOW,
    generateCode: () => 'abc123',
    logError: (message) => {
      logErrors.push(message)
    },
  })
}

function inboundEvent(overrides: Partial<FeishuInboundEvent> = {}): FeishuInboundEvent {
  return {
    messageId: 'om_msg',
    chatId: 'oc_chat',
    chatType: 'p2p',
    senderId: 'ou_sender',
    messageType: 'text',
    content: JSON.stringify({ text: 'hello there' }),
    mentions: [],
    createTime: '1700000000000',
    ...overrides,
  }
}

function writeAccess(overrides: Partial<Access>): void {
  saveAccess(accessFile, {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
    ...overrides,
  })
}

describe('handleInbound — delivery', () => {
  test('delivers an allowlisted DM and tags it with routing meta', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const notes: Note[] = []
    const core = makeCore(new FakeTransport(), notes)

    await core.handleInbound(inboundEvent())

    expect(notes).toHaveLength(1)
    expect(notes[0]?.content).toBe('hello there')
    expect(notes[0]?.meta).toEqual({
      chat_id: 'oc_chat',
      message_id: 'om_msg',
      chat_type: 'p2p',
      sender_id: 'ou_sender',
    })
  })

  test('delivers a group message when the bot is mentioned', async () => {
    writeAccess({ groups: { oc_group: { requireMention: true, allowFrom: [] } } })
    const notes: Note[] = []
    const core = makeCore(new FakeTransport('ou_bot'), notes)

    await core.handleInbound(
      inboundEvent({
        chatId: 'oc_group',
        chatType: 'group',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      }),
    )

    expect(notes).toHaveLength(1)
    expect(notes[0]?.meta.chat_type).toBe('group')
  })
})

describe('handleInbound — pairing', () => {
  test('a new DM sender is sent a pairing code, not delivered to Claude', async () => {
    writeAccess({ dmPolicy: 'pairing' })
    const notes: Note[] = []
    const transport = new FakeTransport()
    const core = makeCore(transport, notes)

    await core.handleInbound(inboundEvent())

    expect(notes).toHaveLength(0)
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.chatId).toBe('oc_chat')
    expect(transport.sent[0]?.text).toContain('abc123')
  })

  test('the pending pairing is persisted to access.json', async () => {
    writeAccess({ dmPolicy: 'pairing' })
    const core = makeCore(new FakeTransport(), [])

    await core.handleInbound(inboundEvent())

    const pending = loadAccess(accessFile).access.pending
    expect(pending['abc123']?.senderId).toBe('ou_sender')
  })
})

describe('handleInbound — drops', () => {
  test('a disabled DM policy delivers nothing and sends nothing', async () => {
    writeAccess({ dmPolicy: 'disabled' })
    const notes: Note[] = []
    const transport = new FakeTransport()
    const core = makeCore(transport, notes)

    await core.handleInbound(inboundEvent())

    expect(notes).toHaveLength(0)
    expect(transport.sent).toHaveLength(0)
  })

  test('a message from an unconfigured group is dropped', async () => {
    writeAccess({})
    const notes: Note[] = []
    const core = makeCore(new FakeTransport('ou_bot'), notes)

    await core.handleInbound(inboundEvent({ chatId: 'oc_unknown', chatType: 'group' }))

    expect(notes).toHaveLength(0)
  })
})

describe('handleInbound — resilience', () => {
  test('a corrupt access.json is reported and the channel still runs', async () => {
    await Bun.write(accessFile, '{ not json')
    const logErrors: string[] = []
    const core = makeCore(new FakeTransport(), [], logErrors)

    await core.handleInbound(inboundEvent())

    expect(logErrors.some((m) => m.includes('access.json'))).toBe(true)
  })

  test('a notifier that throws is caught — handleInbound never rejects', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const logErrors: string[] = []
    const core = makeCore(new FakeTransport(), [], logErrors, () => {
      throw new Error('notify blew up')
    })

    await core.handleInbound(inboundEvent())

    expect(logErrors.some((m) => m.includes('inbound'))).toBe(true)
  })
})

describe('tools', () => {
  test('exposes reply, react, and edit_message', () => {
    const core = makeCore(new FakeTransport(), [])
    expect(core.tools.map((t) => t.name).sort()).toEqual(['edit_message', 'react', 'reply'])
  })
})

describe('handleTool — reply', () => {
  test('sends the text and reports success', async () => {
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    const result = await core.handleTool('reply', { chat_id: 'oc_chat', text: 'hi back' })

    expect(result.isError).toBeUndefined()
    expect(transport.sent).toEqual([{ chatId: 'oc_chat', text: 'hi back' }])
  })

  test('a missing argument yields an error result, not a throw', async () => {
    const core = makeCore(new FakeTransport(), [])
    const result = await core.handleTool('reply', { chat_id: 'oc_chat' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('text')
  })

  test('a transport failure becomes an error result, not a throw', async () => {
    const transport = new FakeTransport()
    transport.failOn = 'sendText'
    const core = makeCore(transport, [])

    const result = await core.handleTool('reply', { chat_id: 'oc_chat', text: 'hi' })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('feishu send failed')
  })
})

describe('handleTool — react and edit_message', () => {
  test('react adds the emoji to the message', async () => {
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    const result = await core.handleTool('react', { message_id: 'om_msg', emoji: 'THUMBSUP' })

    expect(result.isError).toBeUndefined()
    expect(transport.reactions).toEqual([{ messageId: 'om_msg', emoji: 'THUMBSUP' }])
  })

  test('edit_message replaces the message text', async () => {
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    const result = await core.handleTool('edit_message', {
      message_id: 'om_msg',
      text: 'revised',
    })

    expect(result.isError).toBeUndefined()
    expect(transport.edits).toEqual([{ messageId: 'om_msg', text: 'revised' }])
  })
})

describe('handleTool — unknown tool', () => {
  test('an unknown tool name yields an error result', async () => {
    const core = makeCore(new FakeTransport(), [])
    const result = await core.handleTool('teleport', {})
    expect(result.isError).toBe(true)
  })
})
