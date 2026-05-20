import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveAccess } from '../src/access-store'
import { IM_MESSAGE_EVENT_TYPE } from '../src/handlers/im-message'
import { createChannelCore } from '../src/server'
import type { Access } from '../src/types'
import { FakeTransport } from './support/fake-transport'

const NOW = 1_700_000_000_000

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

function writeAccess(overrides: Partial<Access>): void {
  saveAccess(accessFile, {
    dmPolicy: 'pairing',
    allowFrom: [],
    groups: {},
    pending: {},
    ...overrides,
  })
}

describe('createChannelCore — event registry wiring', () => {
  test('exposes a route for every registered event type', () => {
    const core = makeCore(new FakeTransport(), [])
    expect(Object.keys(core.routes)).toContain(IM_MESSAGE_EVENT_TYPE)
  })

  test('a route callback dispatches through the matching handler', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const notes: Note[] = []
    const core = makeCore(new FakeTransport(), notes)

    await core.routes[IM_MESSAGE_EVENT_TYPE]?.(rawImEvent())

    expect(notes).toHaveLength(1)
    expect(notes[0]?.content).toBe('hello there')
    expect(notes[0]?.meta.kind).toBe('message')
    expect(notes[0]?.meta.chat_id).toBe('oc_chat')
  })
})

describe('handleEvent — dispatch', () => {
  test('delivers an im.message event through its handler', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const notes: Note[] = []
    const core = makeCore(new FakeTransport(), notes)

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())

    expect(notes).toHaveLength(1)
    expect(notes[0]?.meta.message_id).toBe('om_msg')
  })

  test('an unregistered event type is a silent no-op', async () => {
    const notes: Note[] = []
    const logErrors: string[] = []
    const core = makeCore(new FakeTransport(), notes, logErrors)

    await core.handleEvent('drive.file.read_v1', { anything: true })

    expect(notes).toHaveLength(0)
    expect(logErrors).toHaveLength(0)
  })

  test('a notifier that throws is caught — handleEvent never rejects', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const logErrors: string[] = []
    const core = makeCore(new FakeTransport(), [], logErrors, () => {
      throw new Error('notify blew up')
    })

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())

    expect(logErrors.some((m) => m.includes('deliver'))).toBe(true)
  })

  test('a malformed payload for a known event type is dropped, not thrown', async () => {
    const notes: Note[] = []
    const logErrors: string[] = []
    const core = makeCore(new FakeTransport(), notes, logErrors)

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, 'not an event')

    expect(notes).toHaveLength(0)
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
