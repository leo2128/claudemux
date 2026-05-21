import { describe, expect, test } from 'bun:test'
import {
  gate,
  isBotMentioned,
  MAX_PAIRING_REPLIES,
  MAX_PENDING,
  PAIRING_TTL_MS,
  pruneExpiredPending,
  type GateInput,
} from '../src/access'
import type { Access, PendingEntry } from '../src/types'

const NOW = 1_700_000_000_000

function access(overrides: Partial<Access> = {}): Access {
  return { dmPolicy: 'pairing', allowFrom: [], groups: {}, pending: {}, ...overrides }
}

function pending(overrides: Partial<PendingEntry> = {}): PendingEntry {
  return {
    kind: 'dm',
    senderId: 'ou_sender',
    chatId: 'oc_chat',
    createdAt: NOW,
    expiresAt: NOW + PAIRING_TTL_MS,
    replies: 1,
    ...overrides,
  }
}

/** A GateInput for a message in a group, with the bot @-mentioned by default. */
function groupInput(overrides: Partial<GateInput> = {}): GateInput {
  return input({
    chatType: 'group',
    chatId: 'oc_group',
    botOpenId: 'ou_bot',
    mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
    ...overrides,
  })
}

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    senderId: 'ou_sender',
    chatId: 'oc_chat',
    chatType: 'p2p',
    access: access(),
    now: NOW,
    newCode: 'aaaaaa',
    ...overrides,
  }
}

describe('gate — guard rails', () => {
  test('drops a message with no sender id', () => {
    const r = gate(input({ senderId: '' }))
    expect(r.action).toBe('drop')
  })

  test('drops an unsupported chat type', () => {
    const r = gate(input({ chatType: 'topic' }))
    expect(r.action).toBe('drop')
  })
})

describe('gate — direct messages', () => {
  test('drops every DM when dmPolicy is disabled', () => {
    const r = gate(input({ access: access({ dmPolicy: 'disabled', allowFrom: ['ou_sender'] }) }))
    expect(r.action).toBe('drop')
  })

  test('delivers a DM from an allowlisted sender', () => {
    const r = gate(input({ access: access({ dmPolicy: 'allowlist', allowFrom: ['ou_sender'] }) }))
    expect(r.action).toBe('deliver')
  })

  test('drops a DM from an unknown sender under allowlist policy', () => {
    const r = gate(input({ access: access({ dmPolicy: 'allowlist' }) }))
    expect(r.action).toBe('drop')
  })

  test('an allowlisted sender is delivered even under pairing policy', () => {
    const r = gate(input({ access: access({ dmPolicy: 'pairing', allowFrom: ['ou_sender'] }) }))
    expect(r.action).toBe('deliver')
  })

  test('a new sender under pairing policy starts a fresh pairing', () => {
    const r = gate(input())
    expect(r.action).toBe('pair')
    if (r.action !== 'pair') throw new Error('unreachable')
    expect(r.code).toBe('aaaaaa')
    expect(r.isResend).toBe(false)
    expect(r.changed).toBe(true)
    const entry = r.access.pending['aaaaaa']
    expect(entry?.senderId).toBe('ou_sender')
    expect(entry?.replies).toBe(1)
    expect(entry?.expiresAt).toBe(NOW + PAIRING_TTL_MS)
  })

  test('a repeat message reuses the existing code and bumps the reply count', () => {
    const r = gate(input({ access: access({ pending: { bbbbbb: pending({ replies: 1 }) } }) }))
    expect(r.action).toBe('pair')
    if (r.action !== 'pair') throw new Error('unreachable')
    expect(r.code).toBe('bbbbbb')
    expect(r.isResend).toBe(true)
    expect(r.access.pending['bbbbbb']?.replies).toBe(2)
  })

  test('stops replying once the pairing reply cap is reached', () => {
    const r = gate(
      input({ access: access({ pending: { bbbbbb: pending({ replies: MAX_PAIRING_REPLIES }) } }) }),
    )
    expect(r.action).toBe('drop')
  })

  test('drops a new pairing once MAX_PENDING requests are outstanding', () => {
    const full: Record<string, PendingEntry> = {}
    for (let i = 0; i < MAX_PENDING; i++) {
      full[`code-${i}`] = pending({ senderId: `ou_other_${i}` })
    }
    const r = gate(input({ access: access({ pending: full }) }))
    expect(r.action).toBe('drop')
  })
})

describe('gate — group messages', () => {
  // Unconfigured groups are covered in 'gate — group pairing' below.
  test('requires a mention when the group policy asks for one', () => {
    const a = access({ groups: { oc_chat: { requireMention: true, allowFrom: [] } } })
    const r = gate(input({ chatType: 'group', access: a, botOpenId: 'ou_bot' }))
    expect(r.action).toBe('drop')
    if (r.action !== 'drop') throw new Error('unreachable')
    expect(r.reason).toBe('bot not mentioned')
  })

  test('a mention-gated group with an unknown bot id drops with a distinct reason', () => {
    const a = access({ groups: { oc_chat: { requireMention: true, allowFrom: [] } } })
    const r = gate(input({ chatType: 'group', access: a }))
    expect(r.action).toBe('drop')
    if (r.action !== 'drop') throw new Error('unreachable')
    expect(r.reason).toContain('open_id is unknown')
  })

  test('delivers a group message when the bot is mentioned', () => {
    const a = access({ groups: { oc_chat: { requireMention: true, allowFrom: [] } } })
    const r = gate(
      input({
        chatType: 'group',
        access: a,
        botOpenId: 'ou_bot',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      }),
    )
    expect(r.action).toBe('deliver')
  })

  test('delivers without a mention when the group policy does not require one', () => {
    const a = access({ groups: { oc_chat: { requireMention: false, allowFrom: [] } } })
    const r = gate(input({ chatType: 'group', access: a }))
    expect(r.action).toBe('deliver')
  })

  test('drops a sender outside a non-empty group allowlist', () => {
    const a = access({ groups: { oc_chat: { requireMention: false, allowFrom: ['ou_other'] } } })
    const r = gate(input({ chatType: 'group', access: a }))
    expect(r.action).toBe('drop')
  })

  test('delivers an allowlisted group sender who mentions the bot', () => {
    const a = access({
      groups: { oc_chat: { requireMention: true, allowFrom: ['ou_sender'] } },
    })
    const r = gate(
      input({
        chatType: 'group',
        access: a,
        botOpenId: 'ou_bot',
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
      }),
    )
    expect(r.action).toBe('deliver')
  })
})

describe('gate — group pairing', () => {
  test('an @-mention in an unconfigured group starts a group pairing', () => {
    const r = gate(groupInput())
    expect(r.action).toBe('pair')
    if (r.action !== 'pair') throw new Error('unreachable')
    expect(r.code).toBe('aaaaaa')
    expect(r.isResend).toBe(false)
    const entry = r.access.pending['aaaaaa']
    expect(entry?.kind).toBe('group')
    expect(entry?.chatId).toBe('oc_group')
    expect(entry?.senderId).toBe('ou_sender')
  })

  test('a non-mention message in an unconfigured group is dropped silently', () => {
    const r = gate(groupInput({ mentions: [] }))
    expect(r.action).toBe('drop')
    if (r.action !== 'drop') throw new Error('unreachable')
    expect(r.reason).toContain('not mentioned')
  })

  test('an unconfigured group cannot pair while the bot open_id is unknown', () => {
    const r = gate(groupInput({ botOpenId: undefined }))
    expect(r.action).toBe('drop')
    if (r.action !== 'drop') throw new Error('unreachable')
    expect(r.reason).toContain('open_id is unknown')
  })

  test('a second mention while a group pairing is pending does not post another code', () => {
    const a = access({ pending: { existing: pending({ kind: 'group', chatId: 'oc_group' }) } })
    const r = gate(groupInput({ access: a }))
    expect(r.action).toBe('drop')
    if (r.action !== 'drop') throw new Error('unreachable')
    expect(r.reason).toBe('group pairing already pending')
  })

  test('a group pairing is dropped once MAX_PENDING requests are outstanding', () => {
    const full: Record<string, PendingEntry> = {}
    for (let i = 0; i < MAX_PENDING; i++) {
      full[`code-${i}`] = pending({ senderId: `ou_other_${i}` })
    }
    const r = gate(groupInput({ access: access({ pending: full }) }))
    expect(r.action).toBe('drop')
  })

  test('a group pending entry never answers a direct message with the group code', () => {
    // The group triggerer later sends a direct message. The kind guard in
    // gateDirect must skip the group entry, so the DM starts its own fresh
    // dm pairing rather than resending the group code.
    const a = access({ pending: { groupcode: pending({ kind: 'group', chatId: 'oc_group' }) } })
    const r = gate(input({ access: a }))
    expect(r.action).toBe('pair')
    if (r.action !== 'pair') throw new Error('unreachable')
    expect(r.code).toBe('aaaaaa')
    expect(r.isResend).toBe(false)
    expect(r.access.pending['aaaaaa']?.kind).toBe('dm')
  })
})

describe('gate — purity and pruning', () => {
  test('does not mutate the input access object', () => {
    const a = access({ pending: { bbbbbb: pending() } })
    const snapshot = JSON.stringify(a)
    gate(input({ access: a }))
    expect(JSON.stringify(a)).toBe(snapshot)
  })

  test('prunes an expired pairing before deciding', () => {
    const a = access({ pending: { stale: pending({ expiresAt: NOW - 1 }) } })
    const r = gate(input({ access: a }))
    expect(r.changed).toBe(true)
    expect(r.access.pending['stale']).toBeUndefined()
  })

  test('an expired pairing does not count against MAX_PENDING', () => {
    const a = access({
      pending: {
        c0: pending({ senderId: 'ou_a', expiresAt: NOW - 1 }),
        c1: pending({ senderId: 'ou_b' }),
        c2: pending({ senderId: 'ou_c' }),
      },
    })
    const r = gate(input({ access: a }))
    // One stale entry pruned leaves room, so a new pairing is created.
    expect(r.action).toBe('pair')
  })
})

describe('pruneExpiredPending', () => {
  test('returns the same reference when nothing expired', () => {
    const a = access({ pending: { live: pending() } })
    const r = pruneExpiredPending(a, NOW)
    expect(r.changed).toBe(false)
    expect(r.access).toBe(a)
  })

  test('drops only the expired entries', () => {
    const a = access({
      pending: { live: pending(), dead: pending({ expiresAt: NOW - 1 }) },
    })
    const r = pruneExpiredPending(a, NOW)
    expect(r.changed).toBe(true)
    expect(Object.keys(r.access.pending)).toEqual(['live'])
  })
})

describe('isBotMentioned', () => {
  test('false when there are no mentions or no bot id', () => {
    expect(isBotMentioned(undefined, 'ou_bot')).toBe(false)
    expect(isBotMentioned([{ key: '@_user_1', id: { open_id: 'ou_bot' } }], undefined)).toBe(false)
  })

  test('true when a mention resolves to the bot open_id', () => {
    expect(isBotMentioned([{ key: '@_user_1', id: { open_id: 'ou_bot' } }], 'ou_bot')).toBe(true)
  })

  test('matches on union_id when open_id is absent', () => {
    expect(isBotMentioned([{ key: '@_user_1', id: { union_id: 'on_bot' } }], 'on_bot')).toBe(true)
  })

  test('false when no mention is the bot', () => {
    expect(isBotMentioned([{ key: '@_user_1', id: { open_id: 'ou_human' } }], 'ou_bot')).toBe(false)
  })
})
