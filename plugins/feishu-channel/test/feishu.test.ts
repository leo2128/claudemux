import { describe, expect, test } from 'bun:test'
import { normalizeInboundEvent } from '../src/feishu'

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
      content: '{"text":"hi"}',
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
      messageType: 'text',
      content: '{"text":"hi"}',
      mentions: [],
      createTime: '1700000000000',
    })
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
