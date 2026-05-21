/**
 * Access control — the security-critical gate every inbound message passes
 * through before it can reach the Claude session.
 *
 * `gate` is a pure function: it takes the current access state plus the
 * message's identity fields and returns a decision. It never reads the clock,
 * never touches disk, and never mutates its input — the caller injects `now`
 * and a candidate `newCode`, and persists `result.access` when `result.changed`
 * is true. That makes every branch here exhaustively unit-testable.
 */

import type { Access, Mention, PendingEntry } from './types'

/** Cap on simultaneously-pending pairing requests — direct and group share it. */
export const MAX_PENDING = 10
/** Cap on pairing-code replies sent to one un-paired sender. */
export const MAX_PAIRING_REPLIES = 2
/** How long a pairing code stays valid, in milliseconds. */
export const PAIRING_TTL_MS = 60 * 60 * 1000

export interface GateInput {
  /** open_id of the message sender. */
  senderId: string
  /** chat_id the message arrived in. */
  chatId: string
  /** Feishu chat_type — `p2p` or `group`. */
  chatType: string
  /** Current access-control state. */
  access: Access
  /** Injected clock (epoch millis) — keeps `gate` pure. */
  now: number
  /** A fresh pairing code, used only if `gate` starts a new pairing. */
  newCode: string
  /** @-mentions carried by the message, for group mention-gating. */
  mentions?: Mention[]
  /** open_id of the bot itself, for group mention-gating. */
  botOpenId?: string
}

export type GateResult =
  | { action: 'deliver'; access: Access; changed: boolean }
  | { action: 'drop'; access: Access; changed: boolean; reason: string }
  | { action: 'pair'; access: Access; changed: boolean; code: string; isResend: boolean }

/**
 * Decide what to do with one inbound message. Returns the (possibly updated)
 * access state in `access` and whether it differs from the input in `changed`.
 */
export function gate(input: GateInput): GateResult {
  const pruned = pruneExpiredPending(input.access, input.now)

  if (!input.senderId) {
    return { action: 'drop', access: pruned.access, changed: pruned.changed, reason: 'missing sender id' }
  }
  if (input.chatType === 'p2p') {
    return gateDirect(input, pruned.access, pruned.changed)
  }
  if (input.chatType === 'group') {
    return gateGroup(input, pruned.access, pruned.changed)
  }
  return {
    action: 'drop',
    access: pruned.access,
    changed: pruned.changed,
    reason: `unsupported chat type: ${input.chatType}`,
  }
}

/** Decide a direct (1:1) message. */
function gateDirect(input: GateInput, access: Access, changed: boolean): GateResult {
  if (access.dmPolicy === 'disabled') {
    return { action: 'drop', access, changed, reason: 'direct messages disabled' }
  }
  if (access.allowFrom.includes(input.senderId)) {
    return { action: 'deliver', access, changed }
  }
  if (access.dmPolicy === 'allowlist') {
    return { action: 'drop', access, changed, reason: 'sender not on allowlist' }
  }

  // dmPolicy === 'pairing' — an unknown sender starts (or repeats) a pairing.
  // The `kind` guard matters: a group-pairing entry also carries a senderId
  // (its triggerer), so without it a group triggerer's later DM would match
  // that entry and be answered with the group's code.
  for (const [code, entry] of Object.entries(access.pending)) {
    if (entry.kind !== 'dm' || entry.senderId !== input.senderId) continue
    if (entry.replies >= MAX_PAIRING_REPLIES) {
      return { action: 'drop', access, changed, reason: 'pairing reply cap reached' }
    }
    const nextAccess: Access = {
      ...access,
      pending: { ...access.pending, [code]: { ...entry, replies: entry.replies + 1 } },
    }
    return { action: 'pair', access: nextAccess, changed: true, code, isResend: true }
  }

  if (Object.keys(access.pending).length >= MAX_PENDING) {
    return { action: 'drop', access, changed, reason: 'too many pending pairings' }
  }
  const entry: PendingEntry = {
    kind: 'dm',
    senderId: input.senderId,
    chatId: input.chatId,
    createdAt: input.now,
    expiresAt: input.now + PAIRING_TTL_MS,
    replies: 1,
  }
  const nextAccess: Access = {
    ...access,
    pending: { ...access.pending, [input.newCode]: entry },
  }
  return { action: 'pair', access: nextAccess, changed: true, code: input.newCode, isResend: false }
}

/** Decide a group message. */
function gateGroup(input: GateInput, access: Access, changed: boolean): GateResult {
  const policy = access.groups[input.chatId]
  if (!policy) {
    return gateUnconfiguredGroup(input, access, changed)
  }
  if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(input.senderId)) {
    return { action: 'drop', access, changed, reason: 'sender not allowed in this group' }
  }
  if (policy.requireMention) {
    // An unknown bot open_id cannot match any mention, so a mention-gated
    // group would drop every message. Report that as its own reason rather
    // than the misleading "bot not mentioned".
    if (input.botOpenId === undefined) {
      return {
        action: 'drop',
        access,
        changed,
        reason: 'group requires an @-mention but the bot open_id is unknown',
      }
    }
    if (!isBotMentioned(input.mentions, input.botOpenId)) {
      return { action: 'drop', access, changed, reason: 'bot not mentioned' }
    }
  }
  return { action: 'deliver', access, changed }
}

/**
 * Decide a message from a group that is not yet in `access.groups`.
 *
 * A group joins `access.groups` the same way an unknown direct sender joins
 * the allowlist — by pairing. But a group pairing is started only by a
 * deliberate @-mention of the bot, the group equivalent of choosing to open a
 * 1:1 chat: that keeps the bot from posting a pairing code in every group it
 * was incidentally added to, and bounds it to one code per group rather than
 * one per group message. A non-mention message is dropped silently.
 *
 * Only one pairing runs per group at a time: while a `group` entry for this
 * chat_id is pending, further mentions are dropped rather than posting a
 * second code. The entry expires via `pruneExpiredPending`, so an un-approved
 * pairing reopens on the next mention after its TTL.
 */
function gateUnconfiguredGroup(
  input: GateInput,
  access: Access,
  changed: boolean,
): GateResult {
  if (input.botOpenId === undefined) {
    return {
      action: 'drop',
      access,
      changed,
      reason: 'unconfigured group; bot open_id is unknown, so a mention cannot be detected',
    }
  }
  if (!isBotMentioned(input.mentions, input.botOpenId)) {
    return { action: 'drop', access, changed, reason: 'unconfigured group; bot not mentioned' }
  }
  for (const entry of Object.values(access.pending)) {
    if (entry.kind === 'group' && entry.chatId === input.chatId) {
      return { action: 'drop', access, changed, reason: 'group pairing already pending' }
    }
  }
  if (Object.keys(access.pending).length >= MAX_PENDING) {
    return { action: 'drop', access, changed, reason: 'too many pending pairings' }
  }
  const entry: PendingEntry = {
    kind: 'group',
    senderId: input.senderId,
    chatId: input.chatId,
    createdAt: input.now,
    expiresAt: input.now + PAIRING_TTL_MS,
    replies: 1,
  }
  const nextAccess: Access = {
    ...access,
    pending: { ...access.pending, [input.newCode]: entry },
  }
  return { action: 'pair', access: nextAccess, changed: true, code: input.newCode, isResend: false }
}

/** True when one of `mentions` resolves to the bot's own open_id. */
export function isBotMentioned(
  mentions: Mention[] | undefined,
  botOpenId: string | undefined,
): boolean {
  if (!mentions || !botOpenId) return false
  return mentions.some((m) => (m.id?.open_id ?? m.id?.union_id) === botOpenId)
}

/**
 * Drop pairing entries whose `expiresAt` is at or before `now`. Returns the
 * same object reference when nothing expired, so callers can cheaply skip a
 * disk write via the `changed` flag.
 */
export function pruneExpiredPending(
  access: Access,
  now: number,
): { access: Access; changed: boolean } {
  const kept: Record<string, PendingEntry> = {}
  let changed = false
  for (const [code, entry] of Object.entries(access.pending)) {
    if (entry.expiresAt > now) {
      kept[code] = entry
    } else {
      changed = true
    }
  }
  return changed ? { access: { ...access, pending: kept }, changed: true } : { access, changed: false }
}
