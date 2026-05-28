import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAccess, saveAccess } from '../../src/access-store'
import type { HandlerContext } from '../../src/events'
import {
  IM_MESSAGE_EVENT_TYPE,
  createImMessageHandler,
  normalizeInboundEvent,
} from '../../src/handlers/im-message'
import { listObservedBots, recordObservedBots } from '../../src/observed-bots-store'
import type { Access } from '../../src/types'
import { FakeTransport } from '../support/fake-transport'

const NOW = 1_700_000_000_000

/** A raw `im.message.receive_v1` event body, with overridable message fields. */
function rawEvent(
  messageOverrides: Record<string, unknown> = {},
  senderId: Record<string, unknown> = { open_id: 'ou_sender', union_id: 'on_s', user_id: 'u_s' },
): Record<string, unknown> {
  return {
    sender: { sender_id: senderId, sender_type: 'user' },
    message: {
      message_id: 'om_msg',
      chat_id: 'oc_chat',
      chat_type: 'p2p',
      message_type: 'text',
      content: '{"text":"hello there"}',
      create_time: '1700000000000',
      mentions: [],
      ...messageOverrides,
    },
  }
}

describe('normalizeInboundEvent — happy path', () => {
  test('reshapes a complete text event into all fields', () => {
    expect(normalizeInboundEvent(rawEvent())).toEqual({
      messageId: 'om_msg',
      chatId: 'oc_chat',
      chatType: 'p2p',
      senderId: 'ou_sender',
      senderType: 'user',
      messageType: 'text',
      content: '{"text":"hello there"}',
      mentions: [],
      createTime: '1700000000000',
    })
  })

  test('captures sender_type=bot for a bot sender', () => {
    const event = normalizeInboundEvent(
      rawEvent({}, { open_id: 'ou_bot', union_id: 'on_b', user_id: 'u_b' }),
    )
    // rawEvent passes sender_type via the second arg only if we override
    // — use a raw object to test bot type directly
    const botRaw = {
      sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'bot' },
      message: {
        message_id: 'om_msg',
        chat_id: 'oc_chat',
        chat_type: 'group',
        message_type: 'text',
        content: '{"text":"hi"}',
        create_time: '1700000000000',
        mentions: [],
      },
    }
    expect(normalizeInboundEvent(botRaw)?.senderType).toBe('bot')
    void event
  })

  test('unwraps a full {event: ...} envelope', () => {
    const event = normalizeInboundEvent({ schema: '2.0', header: {}, event: rawEvent() })
    expect(event?.messageId).toBe('om_msg')
    expect(event?.senderId).toBe('ou_sender')
  })

  test('a missing message_type defaults to "unknown"', () => {
    expect(normalizeInboundEvent(rawEvent({ message_type: undefined }))?.messageType).toBe(
      'unknown',
    )
  })

  test('a missing create_time becomes an empty string', () => {
    expect(normalizeInboundEvent(rawEvent({ create_time: undefined }))?.createTime).toBe('')
  })
})

describe('normalizeInboundEvent — rejects incomplete events', () => {
  test('returns null when the sender open_id is missing', () => {
    expect(normalizeInboundEvent(rawEvent({}, { union_id: 'on_s' }))).toBeNull()
  })

  test('returns null when chat_id is missing', () => {
    expect(normalizeInboundEvent(rawEvent({ chat_id: undefined }))).toBeNull()
  })

  test('returns null when message_id is missing', () => {
    expect(normalizeInboundEvent(rawEvent({ message_id: undefined }))).toBeNull()
  })

  test('returns null for non-object input', () => {
    expect(normalizeInboundEvent(null)).toBeNull()
    expect(normalizeInboundEvent(undefined)).toBeNull()
    expect(normalizeInboundEvent('a string')).toBeNull()
    expect(normalizeInboundEvent(42)).toBeNull()
  })

  test('returns null for an empty object', () => {
    expect(normalizeInboundEvent({})).toBeNull()
  })
})

describe('normalizeInboundEvent — mentions', () => {
  test('normalizes a mention with key, id, and name', () => {
    const event = normalizeInboundEvent(
      rawEvent({
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_bot', union_id: 'on_bot' }, name: 'Bot' },
        ],
      }),
    )
    expect(event?.mentions).toEqual([
      { key: '@_user_1', id: { open_id: 'ou_bot', union_id: 'on_bot' }, name: 'Bot' },
    ])
  })

  test('drops a mention with no key', () => {
    const event = normalizeInboundEvent(
      rawEvent({ mentions: [{ id: { open_id: 'ou_x' } }, { key: '@_user_1' }] }),
    )
    expect(event?.mentions).toEqual([{ key: '@_user_1' }])
  })

  test('a non-array mentions field yields an empty array', () => {
    expect(normalizeInboundEvent(rawEvent({ mentions: 'nope' }))?.mentions).toEqual([])
  })

  test('non-object mention items are skipped', () => {
    const event = normalizeInboundEvent(
      rawEvent({ mentions: ['raw', null, { key: '@_user_1' }] }),
    )
    expect(event?.mentions).toEqual([{ key: '@_user_1' }])
  })
})

let dir: string
let accessFile: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'feishu-im-handler-'))
  accessFile = join(dir, 'access.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Build a HandlerContext wired to the temp access file and the given fakes. */
function makeCtx(
  transport: FakeTransport,
  opts: { logErrors?: string[]; debugLogs?: string[]; generateCode?: () => string; baseDir?: string } = {},
): HandlerContext {
  return {
    transport,
    accessFile,
    baseDir: opts.baseDir ?? dir,
    now: () => NOW,
    generateCode: opts.generateCode ?? (() => 'abc123'),
    logError: (message) => {
      opts.logErrors?.push(message)
    },
    logDebug: (message) => {
      opts.debugLogs?.push(message)
    },
  }
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

describe('createImMessageHandler — identity', () => {
  test('subscribes to im.message.receive_v1', () => {
    expect(createImMessageHandler().eventType).toBe(IM_MESSAGE_EVENT_TYPE)
  })
})

describe('createImMessageHandler — delivery', () => {
  test('delivers an allowlisted DM and tags it with routing meta', async () => {
    writeAccess({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] })
    const handler = createImMessageHandler()

    const delivery = await handler.handle(rawEvent(), makeCtx(new FakeTransport()))

    expect(delivery?.content).toBe('hello there')
    expect(delivery?.meta).toEqual({
      kind: 'message',
      chat_id: 'oc_chat',
      message_id: 'om_msg',
      chat_type: 'p2p',
      sender_id: 'ou_sender',
    })
  })

  test('delivers a group message when the bot is mentioned', async () => {
    writeAccess({ groups: { oc_group: { requireMention: true, allowFrom: [] } } })
    const handler = createImMessageHandler()

    const delivery = await handler.handle(
      rawEvent({
        chat_id: 'oc_group',
        chat_type: 'group',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      }),
      makeCtx(new FakeTransport('ou_bot')),
    )

    expect(delivery?.meta.chat_type).toBe('group')
    expect(delivery?.meta.kind).toBe('message')
  })
})

describe('createImMessageHandler — pairing', () => {
  test('a new DM sender is sent a pairing code, not delivered to Claude', async () => {
    writeAccess({ dmPolicy: 'pairing' })
    const transport = new FakeTransport()
    const handler = createImMessageHandler()

    const delivery = await handler.handle(rawEvent(), makeCtx(transport))

    expect(delivery).toBeNull()
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.chatId).toBe('oc_chat')
    expect(transport.sent[0]?.text).toContain('abc123')
  })

  test('the pending pairing is persisted to access.json', async () => {
    writeAccess({ dmPolicy: 'pairing' })
    const handler = createImMessageHandler()

    await handler.handle(rawEvent(), makeCtx(new FakeTransport()))

    expect(loadAccess(accessFile).access.pending['abc123']?.senderId).toBe('ou_sender')
  })
})

describe('createImMessageHandler — group pairing', () => {
  test('an @-mention in an unconfigured group posts a pairing code into the group', async () => {
    writeAccess({})
    const transport = new FakeTransport('ou_bot')
    const handler = createImMessageHandler()

    const delivery = await handler.handle(
      rawEvent({
        chat_id: 'oc_group',
        chat_type: 'group',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      }),
      makeCtx(transport),
    )

    expect(delivery).toBeNull()
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.chatId).toBe('oc_group')
    expect(transport.sent[0]?.text).toContain('abc123')
    expect(transport.sent[0]?.text).toContain('authorize this group')

    const entry = loadAccess(accessFile).access.pending['abc123']
    expect(entry?.kind).toBe('group')
    expect(entry?.chatId).toBe('oc_group')
  })

  test('a non-mention message in an unconfigured group sends no code', async () => {
    writeAccess({})
    const transport = new FakeTransport('ou_bot')
    const handler = createImMessageHandler()

    const delivery = await handler.handle(
      rawEvent({ chat_id: 'oc_group', chat_type: 'group' }),
      makeCtx(transport),
    )

    expect(delivery).toBeNull()
    expect(transport.sent).toHaveLength(0)
    expect(loadAccess(accessFile).access.pending).toEqual({})
  })
})

describe('createImMessageHandler — group follow-user policy', () => {
  test('delivers an allowlisted sender who @-mentions the bot, with no groups entry', async () => {
    writeAccess({ groupPolicy: 'follow-user', allowFrom: ['ou_sender'] })
    const handler = createImMessageHandler()

    const delivery = await handler.handle(
      rawEvent({
        chat_id: 'oc_group',
        chat_type: 'group',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      }),
      makeCtx(new FakeTransport('ou_bot')),
    )

    expect(delivery?.meta.chat_type).toBe('group')
    expect(delivery?.meta.kind).toBe('message')
  })

  test('a non-allowlisted sender mentioning the bot is dropped, posts no code', async () => {
    writeAccess({ groupPolicy: 'follow-user' })
    const transport = new FakeTransport('ou_bot')
    const handler = createImMessageHandler()

    const delivery = await handler.handle(
      rawEvent({
        chat_id: 'oc_group',
        chat_type: 'group',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      }),
      makeCtx(transport),
    )

    expect(delivery).toBeNull()
    expect(transport.sent).toHaveLength(0)
    expect(loadAccess(accessFile).access.pending).toEqual({})
  })
})

describe('createImMessageHandler — observed-bot delivery (follow-user policy)', () => {
  test('delivers a message from a peer bot in observed-bots that @-mentions the bot', async () => {
    writeAccess({ groupPolicy: 'follow-user', allowFrom: [] })
    const transport = new FakeTransport('ou_self')
    recordObservedBots(dir, transport.appId, 'oc_group', [{ openId: 'ou_peer_bot', name: 'PeerBot' }])
    const handler = createImMessageHandler()

    const delivery = await handler.handle(
      {
        sender: { sender_id: { open_id: 'ou_peer_bot' }, sender_type: 'bot' },
        message: {
          message_id: 'om_bot_msg',
          chat_id: 'oc_group',
          chat_type: 'group',
          message_type: 'text',
          content: '{"text":"hello from peer"}',
          create_time: '1700000000000',
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_self' } }],
        },
      },
      makeCtx(transport),
    )

    expect(delivery?.content).toBe('hello from peer')
    expect(delivery?.meta.sender_id).toBe('ou_peer_bot')
  })

  test('observed bot without @-mention is still dropped', async () => {
    writeAccess({ groupPolicy: 'follow-user', allowFrom: [] })
    const transport = new FakeTransport('ou_self')
    recordObservedBots(dir, transport.appId, 'oc_group', [{ openId: 'ou_peer_bot', name: 'PeerBot' }])
    const handler = createImMessageHandler()

    const delivery = await handler.handle(
      {
        sender: { sender_id: { open_id: 'ou_peer_bot' }, sender_type: 'bot' },
        message: {
          message_id: 'om_bot_msg2',
          chat_id: 'oc_group',
          chat_type: 'group',
          message_type: 'text',
          content: '{"text":"no mention"}',
          create_time: '1700000000000',
          mentions: [],
        },
      },
      makeCtx(transport),
    )

    expect(delivery).toBeNull()
  })

  test('observed bot from a different group cannot deliver into this group', async () => {
    writeAccess({ groupPolicy: 'follow-user', allowFrom: [] })
    const transport = new FakeTransport('ou_self')
    // Register the bot only in 'oc_other_group', not 'oc_group'
    recordObservedBots(dir, transport.appId, 'oc_other_group', [{ openId: 'ou_peer_bot', name: 'PeerBot' }])
    const handler = createImMessageHandler()

    const delivery = await handler.handle(
      {
        sender: { sender_id: { open_id: 'ou_peer_bot' }, sender_type: 'bot' },
        message: {
          message_id: 'om_bot_msg3',
          chat_id: 'oc_group',
          chat_type: 'group',
          message_type: 'text',
          content: '{"text":"cross-group attempt"}',
          create_time: '1700000000000',
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_self' } }],
        },
      },
      makeCtx(transport),
    )

    expect(delivery).toBeNull()
  })

  test('a human open_id in observed-bots with sender_type=user cannot bypass allowFrom', async () => {
    // Regression: /introduce mentions can include human open_ids. A human whose
    // open_id ended up in observed-bots must NOT be delivered unless they are
    // also on allowFrom.
    writeAccess({ groupPolicy: 'follow-user', allowFrom: [] })
    const transport = new FakeTransport('ou_self')
    recordObservedBots(dir, transport.appId, 'oc_group', [{ openId: 'ou_human', name: 'Alice' }])
    const handler = createImMessageHandler()

    const delivery = await handler.handle(
      {
        sender: { sender_id: { open_id: 'ou_human' }, sender_type: 'user' },
        message: {
          message_id: 'om_human_msg',
          chat_id: 'oc_group',
          chat_type: 'group',
          message_type: 'text',
          content: '{"text":"bypass attempt"}',
          create_time: '1700000000000',
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_self' } }],
        },
      },
      makeCtx(transport),
    )

    expect(delivery).toBeNull()
  })
})

describe('createImMessageHandler — group block policy', () => {
  test('drops a group message and sends nothing', async () => {
    writeAccess({ groupPolicy: 'block', allowFrom: ['ou_sender'] })
    const transport = new FakeTransport('ou_bot')
    const handler = createImMessageHandler()

    const delivery = await handler.handle(
      rawEvent({
        chat_id: 'oc_group',
        chat_type: 'group',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      }),
      makeCtx(transport),
    )

    expect(delivery).toBeNull()
    expect(transport.sent).toHaveLength(0)
  })
})

describe('createImMessageHandler — drops', () => {
  test('a disabled DM policy delivers nothing and sends nothing', async () => {
    writeAccess({ dmPolicy: 'disabled' })
    const transport = new FakeTransport()
    const handler = createImMessageHandler()

    const delivery = await handler.handle(rawEvent(), makeCtx(transport))

    expect(delivery).toBeNull()
    expect(transport.sent).toHaveLength(0)
  })

  test('a message from an unconfigured group is dropped', async () => {
    writeAccess({})
    const handler = createImMessageHandler()

    const delivery = await handler.handle(
      rawEvent({ chat_id: 'oc_unknown', chat_type: 'group' }),
      makeCtx(new FakeTransport('ou_bot')),
    )

    expect(delivery).toBeNull()
  })

  test('an unparseable raw payload is dropped, not thrown', async () => {
    const handler = createImMessageHandler()
    expect(await handler.handle('not an event', makeCtx(new FakeTransport()))).toBeNull()
  })
})

describe('createImMessageHandler — resilience', () => {
  test('a corrupt access.json is reported and the event still processes', async () => {
    writeFileSync(accessFile, '{ not json')
    const logErrors: string[] = []
    const handler = createImMessageHandler()

    await handler.handle(rawEvent(), makeCtx(new FakeTransport(), { logErrors }))

    expect(logErrors.some((m) => m.includes('access.json'))).toBe(true)
  })
})

describe('createImMessageHandler — drop diagnostics', () => {
  test('a dropped message is logged with its reason and sender identity', async () => {
    writeAccess({ dmPolicy: 'disabled' })
    const debugLogs: string[] = []
    const handler = createImMessageHandler()

    await handler.handle(rawEvent(), makeCtx(new FakeTransport(), { debugLogs }))

    expect(debugLogs).toHaveLength(1)
    expect(debugLogs[0]).toContain('ou_sender')
    expect(debugLogs[0]).toContain('direct messages disabled')
  })
})

describe('createImMessageHandler — pairing send failure', () => {
  test('a failed pairing send is logged and the pending entry is not persisted', async () => {
    writeAccess({ dmPolicy: 'pairing' })
    const transport = new FakeTransport()
    transport.failOn = 'sendText'
    const logErrors: string[] = []
    const handler = createImMessageHandler()

    const delivery = await handler.handle(rawEvent(), makeCtx(transport, { logErrors }))

    expect(delivery).toBeNull()
    expect(logErrors.some((m) => m.includes('pairing code'))).toBe(true)
    // The send failed, so nothing is persisted — the sender's next message
    // starts a fresh pairing rather than finding a code they never received.
    expect(loadAccess(accessFile).access.pending).toEqual({})
  })
})

// ── ambient /introduce (bot sender, no @-mention required) ──────────────────

/** A raw group event from a bot sender (no @-mention of our bot). */
function botIntroduceEvent(
  text: string,
  chatId = 'oc_grp',
  senderType = 'bot',
): Record<string, unknown> {
  return {
    sender: { sender_id: { open_id: 'ou_peer_bot' }, sender_type: senderType },
    message: {
      message_id: 'om_ambient',
      chat_id: chatId,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: '1700000000000',
      mentions: [],
    },
  }
}

describe('createImMessageHandler — ambient /introduce (bot broadcasts without @-mention)', () => {
  test('records the bot sender in observed-bots for a follow-user group', async () => {
    writeAccess({ groupPolicy: 'follow-user', allowFrom: [] })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    const delivery = await handler.handle(botIntroduceEvent('/introduce'), makeCtx(transport))

    expect(delivery).toBeNull()
    const bots = listObservedBots(dir, transport.appId, 'oc_grp')
    expect(bots.map((b) => b.openId)).toContain('ou_peer_bot')
  })

  test('silent — no ack message sent', async () => {
    writeAccess({ groupPolicy: 'follow-user', allowFrom: [] })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    await handler.handle(botIntroduceEvent('/introduce'), makeCtx(transport))

    expect(transport.sent).toHaveLength(0)
  })

  test('records for an authorized allowlist group', async () => {
    writeAccess({ groupPolicy: 'allowlist', groups: { oc_grp: { requireMention: false, allowFrom: [] } } })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    await handler.handle(botIntroduceEvent('/introduce'), makeCtx(transport))

    expect(listObservedBots(dir, transport.appId, 'oc_grp').map((b) => b.openId)).toContain('ou_peer_bot')
  })

  test('does NOT record in an unconfigured allowlist group', async () => {
    writeAccess({ groupPolicy: 'allowlist', groups: {} })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    await handler.handle(botIntroduceEvent('/introduce'), makeCtx(transport))

    expect(listObservedBots(dir, transport.appId, 'oc_grp')).toHaveLength(0)
  })

  test('does NOT record in a blocked group', async () => {
    writeAccess({ groupPolicy: 'block', allowFrom: ['ou_peer_bot'] })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    await handler.handle(botIntroduceEvent('/introduce'), makeCtx(transport))

    expect(listObservedBots(dir, transport.appId, 'oc_grp')).toHaveLength(0)
  })

  test('does NOT record a human sender (senderType=user)', async () => {
    writeAccess({ groupPolicy: 'follow-user', allowFrom: [] })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    await handler.handle(botIntroduceEvent('/introduce', 'oc_grp', 'user'), makeCtx(transport))

    expect(listObservedBots(dir, transport.appId, 'oc_grp')).toHaveLength(0)
  })

  test('single-step: ambient records sender so same-message gate can deliver (follow-user + @-mention)', async () => {
    // Bot A sends "/introduce @OurBot": ambient records Bot A first, then
    // observedBotIds includes Bot A, so gate delivers — enabling single-step
    // self-introduction. The message is still consumed (null) because /introduce
    // always returns null regardless of delivery.
    writeAccess({ groupPolicy: 'follow-user', allowFrom: [] })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    const delivery = await handler.handle(
      {
        sender: { sender_id: { open_id: 'ou_peer_bot' }, sender_type: 'bot' },
        message: {
          message_id: 'om_self_intro',
          chat_id: 'oc_grp',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_self /introduce' }),
          create_time: '1700000000000',
          mentions: [{ key: '@_user_self', id: { open_id: 'ou_self' }, name: 'OurBot' }],
        },
      },
      makeCtx(transport),
    )

    // /introduce always returns null, but the bot is now recorded
    expect(delivery).toBeNull()
    expect(listObservedBots(dir, transport.appId, 'oc_grp').map((b) => b.openId)).toContain('ou_peer_bot')
  })

  test('does NOT record bot not in group allowFrom (allowlist policy with non-empty allowFrom)', async () => {
    writeAccess({ groupPolicy: 'allowlist', groups: { oc_grp: { requireMention: false, allowFrom: ['ou_allowed'] } } })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    await handler.handle(botIntroduceEvent('/introduce'), makeCtx(transport))

    // ou_peer_bot is not in allowFrom=['ou_allowed'] → should not be recorded
    expect(listObservedBots(dir, transport.appId, 'oc_grp')).toHaveLength(0)
  })

  test('records bot in group allowFrom (allowlist policy)', async () => {
    writeAccess({ groupPolicy: 'allowlist', groups: { oc_grp: { requireMention: false, allowFrom: ['ou_peer_bot'] } } })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    await handler.handle(botIntroduceEvent('/introduce'), makeCtx(transport))

    expect(listObservedBots(dir, transport.appId, 'oc_grp').map((b) => b.openId)).toContain('ou_peer_bot')
  })

  test('combination: bot sender + @OurBot + @BotB /introduce → ambient records sender, handleIntroduce records BotB, ack for BotB only', async () => {
    writeAccess({ groupPolicy: 'follow-user', allowFrom: [] })
    const transport = new FakeTransport('ou_self')
    // Pre-seed peer bot so gate delivers (otherwise handleIntroduce won't run)
    recordObservedBots(dir, transport.appId, 'oc_grp', [{ openId: 'ou_peer_bot', name: 'PeerBot' }])
    const handler = createImMessageHandler()

    await handler.handle(
      {
        sender: { sender_id: { open_id: 'ou_peer_bot' }, sender_type: 'bot' },
        message: {
          message_id: 'om_combo',
          chat_id: 'oc_grp',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@_user_self @_user_ext /introduce' }),
          create_time: '1700000000000',
          mentions: [
            { key: '@_user_self', id: { open_id: 'ou_self' }, name: 'OurBot' },
            { key: '@_user_ext', id: { open_id: 'ou_ext_bot' }, name: 'ExtBot' },
          ],
        },
      },
      makeCtx(transport),
    )

    // ambient records the sender; handleIntroduce records all mentions (self + ext)
    const bots = listObservedBots(dir, transport.appId, 'oc_grp').map((b) => b.openId)
    expect(bots).toContain('ou_peer_bot')  // ambient path
    expect(bots).toContain('ou_ext_bot')   // handleIntroduce
    // ack contains all mentioned bots (handleIntroduce records all mentions including self)
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.text).toContain('ExtBot')
  })
})

// ── /introduce collaboration handshake ──────────────────────────────────────

/** A group event mentioning two bots plus a sender, for /introduce tests. */
function introduceEvent(text: string, chatId = 'oc_grp'): Record<string, unknown> {
  return {
    sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
    message: {
      message_id: 'om_intro',
      chat_id: chatId,
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text }),
      create_time: '1700000000000',
      mentions: [
        { key: '@_user_1', id: { open_id: 'ou_self' }, name: 'BotSelf' },
        { key: '@_user_2', id: { open_id: 'ou_peer' }, name: 'BotPeer' },
      ],
    },
  }
}

describe('createImMessageHandler — /introduce command', () => {
  test('bare /introduce is consumed (returns null) and persists bots', async () => {
    writeAccess({ groupPolicy: 'allowlist', groups: { oc_grp: { requireMention: false, allowFrom: [] } } })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    const delivery = await handler.handle(introduceEvent('/introduce'), makeCtx(transport))

    expect(delivery).toBeNull()
    const bots = listObservedBots(dir, transport.appId, 'oc_grp')
    expect(bots.map((b) => b.openId)).toContain('ou_peer')
  })

  test('/introduce with leading mention keys is matched', async () => {
    writeAccess({ groupPolicy: 'allowlist', groups: { oc_grp: { requireMention: false, allowFrom: [] } } })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    // Content has raw Feishu placeholders; isIntroduceCommand strips them by key.
    const event = introduceEvent('@_user_1 @_user_2 /introduce')
    const delivery = await handler.handle(event, makeCtx(transport))

    expect(delivery).toBeNull()
    const bots = listObservedBots(dir, transport.appId, 'oc_grp')
    expect(bots.length).toBeGreaterThan(0)
  })

  test('leading mentions with display names containing spaces are stripped correctly', async () => {
    // Regression: old word-boundary regex stopped at the space inside "Claude Code",
    // leaving "Code @Bot B /introduce" which did not match.
    writeAccess({ groupPolicy: 'allowlist', groups: { oc_grp: { requireMention: false, allowFrom: [] } } })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    // Simulate bots whose display names contain spaces.
    const event = {
      sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
      message: {
        message_id: 'om_intro',
        chat_id: 'oc_grp',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 @_user_2 /introduce' }),
        create_time: '1700000000000',
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_self' }, name: 'Claude Code' },
          { key: '@_user_2', id: { open_id: 'ou_peer' }, name: 'Bot B' },
        ],
      },
    }
    const delivery = await handler.handle(event, makeCtx(transport))

    expect(delivery).toBeNull()
    expect(listObservedBots(dir, transport.appId, 'oc_grp').map((b) => b.openId)).toContain('ou_peer')
  })

  test('/introducer does not match', async () => {
    writeAccess({ groupPolicy: 'allowlist', groups: { oc_grp: { requireMention: false, allowFrom: [] } } })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    const delivery = await handler.handle(introduceEvent('/introducer'), makeCtx(transport))

    // Falls through to normal delivery, not consumed
    expect(delivery).not.toBeNull()
    expect(listObservedBots(dir, transport.appId, 'oc_grp')).toHaveLength(0)
  })

  test('explanatory text before /introduce does not match', async () => {
    writeAccess({ groupPolicy: 'allowlist', groups: { oc_grp: { requireMention: false, allowFrom: [] } } })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    const delivery = await handler.handle(introduceEvent('please run /introduce'), makeCtx(transport))

    expect(delivery).not.toBeNull()
  })

  test('unauthorized sender does not write and does not ack', async () => {
    // group policy allowlist but group not in access.groups → gate returns 'pair'
    writeAccess({ groupPolicy: 'allowlist', groups: {} })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    const delivery = await handler.handle(introduceEvent('/introduce'), makeCtx(transport))

    expect(delivery).toBeNull()
    expect(transport.sent).toHaveLength(0)
    expect(listObservedBots(dir, transport.appId, 'oc_grp')).toHaveLength(0)
  })

  test('/introduce on an unconfigured group does not persist a phantom pairing code', async () => {
    // Regression: the old code called persist() unconditionally before checking
    // action, causing gate()'s 'pair' decision to be saved without ever sending
    // the code — subsequent @-mentions then hit "group pairing already pending".
    writeAccess({ groupPolicy: 'allowlist', groups: {} })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    await handler.handle(introduceEvent('/introduce'), makeCtx(transport))

    // No pending pairing code should have been written
    const { access } = loadAccess(accessFile)
    expect(Object.keys(access.pending)).toHaveLength(0)
  })

  test('no external bot in mentions → no write, no ack', async () => {
    writeAccess({ groupPolicy: 'allowlist', groups: { oc_grp: { requireMention: false, allowFrom: [] } } })
    // Only self in mentions
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()
    const event = {
      sender: { sender_id: { open_id: 'ou_sender' }, sender_type: 'user' },
      message: {
        message_id: 'om_intro',
        chat_id: 'oc_grp',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '/introduce' }),
        create_time: '1700000000000',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_self' }, name: 'BotSelf' }],
      },
    }

    await handler.handle(event, makeCtx(transport))

    expect(transport.sent).toHaveLength(0)
    expect(listObservedBots(dir, transport.appId, 'oc_grp')).toHaveLength(0)
  })

  test('sends an ack when authorized and external bot exists', async () => {
    writeAccess({ groupPolicy: 'allowlist', groups: { oc_grp: { requireMention: false, allowFrom: [] } } })
    const transport = new FakeTransport('ou_self')
    const handler = createImMessageHandler()

    await handler.handle(introduceEvent('/introduce'), makeCtx(transport))

    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]?.text).toContain('✅')
    expect(transport.sent[0]?.chatId).toBe('oc_grp')
  })

  test('failed ack is logged but store write already succeeded', async () => {
    writeAccess({ groupPolicy: 'allowlist', groups: { oc_grp: { requireMention: false, allowFrom: [] } } })
    const transport = new FakeTransport('ou_self')
    transport.failOn = 'sendText'
    const logErrors: string[] = []
    const handler = createImMessageHandler()

    await handler.handle(introduceEvent('/introduce'), makeCtx(transport, { logErrors }))

    expect(logErrors.some((m) => m.includes('/introduce'))).toBe(true)
    // Store write happened before the ack attempt
    expect(listObservedBots(dir, transport.appId, 'oc_grp').length).toBeGreaterThan(0)
  })
})
