import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveAccess } from '../src/access-store'
import { DOC_COMMENT_EVENT_TYPE } from '../src/handlers/doc-comment'
import { IM_MESSAGE_EVENT_TYPE } from '../src/handlers/im-message'
import {
  createChannelCore,
  FEISHU_TEXT_LIMIT,
  loadCredentials,
  readEnvFile,
  RECEIVED_REACTION_EMOJI,
} from '../src/server'
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

/** A raw `im.message.receive_v1` event body with a given message_id and chat_id. */
function rawIm(messageId: string, chatId: string): Record<string, unknown> {
  return {
    sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: chatId,
      chat_type: 'p2p',
      message_type: 'text',
      content: '{"text":"hello there"}',
      mentions: [],
    },
  }
}

/** A raw `im.message.receive_v1` event body from a fixed test sender. */
function rawImEvent(): Record<string, unknown> {
  return rawIm('om_msg', 'oc_chat')
}

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

describe('handleTool — reply chunking', () => {
  test('a reply within the limit is sent as a single message', async () => {
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    await core.handleTool('reply', { chat_id: 'oc_chat', text: 'short enough' })

    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.text).toBe('short enough')
  })

  test('a reply over the limit is split into messages that each fit', async () => {
    const transport = new FakeTransport()
    const core = makeCore(transport, [])
    const long = 'x'.repeat(FEISHU_TEXT_LIMIT * 2 + 100)

    const result = await core.handleTool('reply', { chat_id: 'oc_chat', text: long })

    expect(result.isError).toBeUndefined()
    expect(transport.sent.length).toBeGreaterThan(1)
    for (const message of transport.sent) {
      expect(message.text.length).toBeLessThanOrEqual(FEISHU_TEXT_LIMIT)
    }
    // Whitespace-free input has no boundary to trim, so the parts rejoin
    // exactly — no content is dropped on the way out.
    expect(transport.sent.map((m) => m.text).join('')).toBe(long)
    expect(JSON.stringify(result.content)).toContain('messages')
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

describe('received-reaction indicator', () => {
  test('adds the received reaction once an inbound chat message is delivered', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())

    expect(transport.reactions).toEqual([
      { messageId: 'om_msg', emoji: RECEIVED_REACTION_EMOJI },
    ])
  })

  test('a reply clears the received reaction for that chat', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())
    await core.handleTool('reply', { chat_id: 'oc_chat', text: 'answered' })

    expect(transport.reactionRemovals).toEqual([
      { messageId: 'om_msg', reactionId: 'rk_om_msg' },
    ])
  })

  test('a reply clears every message still pending in that chat', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawIm('om_a', 'oc_chat'))
    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawIm('om_b', 'oc_chat'))
    await core.handleTool('reply', { chat_id: 'oc_chat', text: 'answered both' })

    expect(transport.reactionRemovals.map((r) => r.messageId).sort()).toEqual(['om_a', 'om_b'])
  })

  test('a reply leaves another chat’s pending reaction in place', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawIm('om_a', 'oc_one'))
    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawIm('om_b', 'oc_two'))
    await core.handleTool('reply', { chat_id: 'oc_one', text: 'answered one' })

    expect(transport.reactionRemovals).toEqual([{ messageId: 'om_a', reactionId: 'rk_om_a' }])

    // The untouched chat still clears on its own reply.
    await core.handleTool('reply', { chat_id: 'oc_two', text: 'answered two' })
    expect(transport.reactionRemovals.map((r) => r.messageId)).toEqual(['om_a', 'om_b'])
  })

  test('a gated-out message gets no reaction', async () => {
    writeAccess({ dmPolicy: 'pairing' })
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())

    expect(transport.reactions).toHaveLength(0)
  })

  test('a delivered doc comment gets no reaction — it is not an IM message', async () => {
    const transport = new FakeTransport()
    const notes: Note[] = []
    const core = makeCore(transport, notes)

    await core.handleEvent(DOC_COMMENT_EVENT_TYPE, {
      file_token: 'doccnAbC123',
      file_type: 'docx',
      comment_id: 'cmt_1',
      user_id: { open_id: 'ou_commenter' },
      is_mentioned: true,
      create_time: '1716200000000',
    })

    expect(notes).toHaveLength(1)
    expect(notes[0]?.meta.kind).toBe('doc_comment')
    expect(transport.reactions).toHaveLength(0)
  })

  test('a failed addReaction is logged and never blocks delivery', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    transport.failOn = 'addReaction'
    const notes: Note[] = []
    const logErrors: string[] = []
    const core = makeCore(transport, notes, logErrors)

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())

    expect(notes).toHaveLength(1)
    expect(logErrors.some((m) => m.includes('received reaction'))).toBe(true)
  })

  test('a failed removeReaction is logged, and the message is not retried later', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    transport.failOn = 'removeReaction'
    const logErrors: string[] = []
    const core = makeCore(transport, [], logErrors)

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())
    const result = await core.handleTool('reply', { chat_id: 'oc_chat', text: 'answered' })

    expect(result.isError).toBeUndefined()
    const removalErrors = (): number =>
      logErrors.filter((m) => m.includes('remove the received reaction')).length
    expect(removalErrors()).toBe(1)

    // The message was dropped from the pending set despite the failure, so a
    // later reply into the same chat does not retry the doomed removal — the
    // removal error count stays at one.
    await core.handleTool('reply', { chat_id: 'oc_chat', text: 'again' })
    expect(removalErrors()).toBe(1)
  })

  test('a reply that fails to send leaves the indicator in place', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport()
    const core = makeCore(transport, [])

    await core.handleEvent(IM_MESSAGE_EVENT_TYPE, rawImEvent())
    transport.failOn = 'sendText'
    const failed = await core.handleTool('reply', { chat_id: 'oc_chat', text: 'answered' })

    expect(failed.isError).toBe(true)
    expect(transport.reactionRemovals).toHaveLength(0)

    // The message is still pending — a later successful reply clears it.
    transport.failOn = undefined
    await core.handleTool('reply', { chat_id: 'oc_chat', text: 'retry' })
    expect(transport.reactionRemovals).toEqual([
      { messageId: 'om_msg', reactionId: 'rk_om_msg' },
    ])
  })
})

describe('handleTool — unknown tool', () => {
  test('an unknown tool name yields an error result', async () => {
    const core = makeCore(new FakeTransport(), [])
    const result = await core.handleTool('teleport', {})
    expect(result.isError).toBe(true)
  })
})

/** Restore an environment variable to a captured prior value. */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

describe('readEnvFile', () => {
  test('a missing file yields an empty map', () => {
    expect(readEnvFile(join(dir, 'nope.env'))).toEqual({})
  })

  test('parses keys, strips surrounding quotes, and ignores noise lines', () => {
    const file = join(dir, '.env')
    writeFileSync(
      file,
      [
        '# a comment',
        '',
        'FEISHU_APP_ID=cli_plain',
        'FEISHU_APP_SECRET="quoted secret"',
        "OTHER='single quoted'",
        'this line is not a key=value assignment',
        '  SPACED  =  trimmed  ',
      ].join('\n'),
    )
    expect(readEnvFile(file)).toEqual({
      FEISHU_APP_ID: 'cli_plain',
      FEISHU_APP_SECRET: 'quoted secret',
      OTHER: 'single quoted',
      SPACED: 'trimmed',
    })
  })
})

describe('loadCredentials', () => {
  test('returns both credentials read from the env file', () => {
    const file = join(dir, '.env')
    writeFileSync(file, 'FEISHU_APP_ID=cli_x\nFEISHU_APP_SECRET=secret_y\n')
    expect(loadCredentials(file)).toEqual({ appId: 'cli_x', appSecret: 'secret_y' })
  })

  test('throws a clear error when a credential is missing', () => {
    const savedSecret = process.env.FEISHU_APP_SECRET
    delete process.env.FEISHU_APP_SECRET
    const file = join(dir, '.env')
    writeFileSync(file, 'FEISHU_APP_ID=cli_x\n')
    try {
      expect(() => loadCredentials(file)).toThrow('Feishu credentials missing')
    } finally {
      restoreEnv('FEISHU_APP_SECRET', savedSecret)
    }
  })

  test('falls back to the process environment when the file is absent', () => {
    const savedId = process.env.FEISHU_APP_ID
    const savedSecret = process.env.FEISHU_APP_SECRET
    process.env.FEISHU_APP_ID = 'cli_env'
    process.env.FEISHU_APP_SECRET = 'secret_env'
    try {
      expect(loadCredentials(join(dir, 'absent.env'))).toEqual({
        appId: 'cli_env',
        appSecret: 'secret_env',
      })
    } finally {
      restoreEnv('FEISHU_APP_ID', savedId)
      restoreEnv('FEISHU_APP_SECRET', savedSecret)
    }
  })
})
