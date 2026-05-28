/**
 * The `im.message.receive_v1` handler — inbound Feishu chat messages.
 *
 * This is the channel's first event handler and the template for the rest.
 * It owns everything specific to one Feishu event type: the raw-payload
 * decode (`normalizeInboundEvent`), the content parse, the access gate, the
 * pairing side effect, and the mapping to a `ChannelDelivery`. The server
 * registers it into the `EventRegistry`; the core pipeline never references
 * it directly.
 */

import { gate } from '../access'
import { loadAccess, saveAccess } from '../access-store'
import { parseInbound } from '../content'
import type { ChannelDelivery, EventHandler, HandlerContext } from '../events'
import { asString, isRecord } from '../json'
import { recordObservedBots } from '../observed-bots-store'
import type { Mention } from '../types'

/** The Feishu event_type this handler subscribes to. */
export const IM_MESSAGE_EVENT_TYPE = 'im.message.receive_v1'

/** A normalized inbound Feishu message, as the handler consumes it. */
export interface FeishuInboundEvent {
  /** message_id (`om_...`) — used to react to or edit this message. */
  messageId: string
  /** chat_id (`oc_...`) — the conversation the message arrived in. */
  chatId: string
  /** Feishu chat_type — `p2p` for a direct message, `group` for a group. */
  chatType: string
  /** open_id of the sender — the identity access control gates on. */
  senderId: string
  /** Feishu message_type — `text`, `post`, `image`, `file`, ... */
  messageType: string
  /** JSON-encoded content string, exactly as Feishu delivered it. */
  content: string
  /** @-mentions carried by the message; always an array, never undefined. */
  mentions: Mention[]
  /** Feishu create_time (epoch millis as a string), or `''` if absent. */
  createTime: string
}

/**
 * Build the `im.message.receive_v1` event handler: decode the raw payload,
 * gate it, and either deliver it, send a pairing prompt, or drop it.
 */
export function createImMessageHandler(): EventHandler {
  return {
    eventType: IM_MESSAGE_EVENT_TYPE,
    async handle(raw: unknown, ctx: HandlerContext): Promise<ChannelDelivery | null> {
      const event = normalizeInboundEvent(raw)
      if (!event) return null

      const parsed = parseInbound({
        message_type: event.messageType,
        content: event.content,
        mentions: event.mentions,
      })

      const loaded = loadAccess(ctx.accessFile)
      if (loaded.corrupt) {
        ctx.logError('access.json was unreadable; started from defaults')
      }

      const decision = gate({
        senderId: event.senderId,
        chatId: event.chatId,
        chatType: event.chatType,
        access: loaded.access,
        now: ctx.now(),
        newCode: ctx.generateCode(),
        mentions: event.mentions,
        botOpenId: ctx.transport.botOpenId,
      })
      const persist = (): void => {
        if (decision.changed) saveAccess(ctx.accessFile, decision.access)
      }

      // /introduce collaboration handshake — intercept before normal routing.
      // Detect using raw content + mention keys (not display names) so names
      // with spaces don't break the prefix-strip. Side effects only fire when
      // the access gate would deliver; for pair/drop we consume silently without
      // persisting — saving a pair decision here would create a phantom pairing
      // code that was never shown to anyone, causing "group pairing already
      // pending" to block legitimate pairings until the entry expires.
      if (isIntroduceCommand(event.content, event.messageType, event.mentions)) {
        if (decision.action === 'deliver') {
          persist()
          await handleIntroduce(event, ctx)
        }
        return null
      }

      switch (decision.action) {
        case 'deliver':
          persist()
          return { content: parsed.text, meta: buildMeta(event) }
        case 'drop':
          persist()
          ctx.logDebug(
            `dropped a message from ${event.senderId} in chat ${event.chatId}: ` +
              decision.reason,
          )
          return null
        case 'pair': {
          // Send the pairing code before recording the pending entry. A
          // transient send failure then leaves no pending entry no one ever
          // received a code for — the next message simply starts a fresh
          // pairing instead of finding a code that was never seen.
          const prompt =
            event.chatType === 'group'
              ? groupPairingPrompt(decision.code)
              : pairingPrompt(decision.code, decision.isResend)
          try {
            await ctx.transport.sendText(event.chatId, prompt)
          } catch (err) {
            ctx.logError('failed to send a pairing code', err)
            return null
          }
          persist()
          return null
        }
      }
    },
  }
}

// ── /introduce collaboration handshake ─────────────────────────────────────
//
// A user sends `@BotA @BotB /introduce` in a group. Each bot receives the
// same event with mentions[] populated from its own app's perspective — the
// open_ids in that list are exactly the ids this app must use to @-mention the
// others. We persist them so `available_bots` can be injected on every later
// delivery in that group.
//
// Feishu has no public API to list bot members of a group; /introduce is the
// only reliable path to learn a peer bot's open_id.

const INTRODUCE_RE = /^\/introduce(?:\s|$)/i

/**
 * True when this message is a /introduce command.
 *
 * Detection operates on the raw message content (before mention-key → display-name
 * replacement) and strips leading mention keys by exact match. This is necessary
 * because display names can contain spaces: after `parseInbound` replaces `@_user_1`
 * with `@Claude Code`, a word-boundary regex only strips `@Claude` and leaves
 * `Code @Bot B /introduce` unmatched. Stripping the original Feishu placeholder
 * tokens (e.g. `@_user_1`) is safe because they never contain spaces.
 *
 * Supports `text` messages only; non-text types (image, file, post) cannot carry
 * a /introduce command and return false immediately.
 */
function isIntroduceCommand(rawContent: string, messageType: string, mentions: Mention[]): boolean {
  if (messageType !== 'text') return false
  let text: string
  try {
    const obj = JSON.parse(rawContent) as Record<string, unknown>
    text = typeof obj.text === 'string' ? obj.text : ''
  } catch {
    return false
  }
  // Strip leading Feishu mention-key tokens (e.g. "@_user_1 ") one at a time.
  // Keys are exact placeholders with no spaces, so stripping them is unambiguous.
  let remaining = text.trimStart()
  let progress = true
  while (progress) {
    progress = false
    for (const m of mentions) {
      if (remaining.startsWith(m.key)) {
        remaining = remaining.slice(m.key.length).trimStart()
        progress = true
        break
      }
    }
  }
  return INTRODUCE_RE.test(remaining)
}

/**
 * Side-effect for an authorized /introduce command: persist observed bots and
 * send a best-effort ack. Only called when the access gate says deliver.
 */
async function handleIntroduce(event: FeishuInboundEvent, ctx: HandlerContext): Promise<void> {
  const botsToRecord = event.mentions
    .map((m) => ({ openId: m.id?.open_id ?? '', name: m.name ?? '' }))
    .filter((b) => b.openId && b.name)

  const hasExternal = botsToRecord.some((b) => b.openId !== ctx.transport.botOpenId)
  if (!hasExternal) {
    ctx.logDebug(`/introduce in ${event.chatId}: no external bot in mentions — ignoring`)
    return
  }

  try {
    recordObservedBots(ctx.baseDir, ctx.transport.appId, event.chatId, botsToRecord)
  } catch (err) {
    ctx.logError('/introduce: failed to persist observed bots', err)
  }

  const items = botsToRecord.map((b) => `@${b.name}`).join(' ')
  try {
    await ctx.transport.sendText(
      event.chatId,
      `✅ 已认识本群 ${botsToRecord.length} 个伙伴：${items}`,
    )
  } catch (err) {
    ctx.logError('/introduce: ack failed', err)
  }
}

/** Build the `<channel>` tag attributes for a delivered message. */
function buildMeta(event: FeishuInboundEvent): Record<string, string> {
  // Keys must be alphanumeric-plus-underscore — a hyphen would be dropped.
  return {
    kind: 'message',
    chat_id: event.chatId,
    message_id: event.messageId,
    chat_type: event.chatType,
    sender_id: event.senderId,
  }
}

/** The message sent back to an un-paired sender, carrying their pairing code. */
function pairingPrompt(code: string, isResend: boolean): string {
  const lead = isResend
    ? 'You already have a pending pairing request for this Claude Code channel.'
    : 'This Claude Code channel must pair with you before it will deliver your messages.'
  return [
    lead,
    `Pairing code: ${code}`,
    'Share this code with the operator running Claude Code so they can approve you.',
  ].join('\n')
}

/**
 * The message posted into an un-paired group, carrying its pairing code. The
 * code is visible to every group member, but it grants nothing on its own —
 * authorizing the group still takes the operator, the access skill, and the
 * running Claude Code session.
 */
function groupPairingPrompt(code: string): string {
  return [
    'This group is not yet authorized for this Claude Code channel.',
    `Pairing code: ${code}`,
    'Share this code with the operator running Claude Code so they can authorize this group.',
  ].join('\n')
}

/**
 * Reshape a raw `im.message.receive_v1` payload into a `FeishuInboundEvent`.
 *
 * Returns `null` when an essential field (sender open_id, chat_id, message_id)
 * is missing, since such an event can neither be gated nor answered. Pure: no
 * I/O, no clock, never throws. Tolerates either the event body alone (what the
 * SDK's `EventDispatcher` delivers) or a full `{ event: ... }` envelope.
 */
export function normalizeInboundEvent(raw: unknown): FeishuInboundEvent | null {
  if (!isRecord(raw)) return null
  const event = isRecord(raw.event) ? raw.event : raw

  const sender = isRecord(event.sender) ? event.sender : {}
  const senderId = isRecord(sender.sender_id) ? sender.sender_id : {}
  const message = isRecord(event.message) ? event.message : {}

  const openId = asString(senderId.open_id)
  const messageId = asString(message.message_id)
  const chatId = asString(message.chat_id)
  if (!openId || !messageId || !chatId) return null

  return {
    messageId,
    chatId,
    chatType: asString(message.chat_type),
    senderId: openId,
    messageType: asString(message.message_type) || 'unknown',
    content: asString(message.content),
    mentions: normalizeMentions(message.mentions),
    createTime: asString(message.create_time),
  }
}

/** Reshape a raw `mentions` array into well-formed `Mention` objects. */
function normalizeMentions(raw: unknown): Mention[] {
  if (!Array.isArray(raw)) return []
  const out: Mention[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const key = asString(item.key)
    if (!key) continue
    const mention: Mention = { key }
    if (isRecord(item.id)) {
      const id: NonNullable<Mention['id']> = {}
      const openId = asString(item.id.open_id)
      const unionId = asString(item.id.union_id)
      const userId = asString(item.id.user_id)
      if (openId) id.open_id = openId
      if (unionId) id.union_id = unionId
      if (userId) id.user_id = userId
      mention.id = id
    }
    const name = asString(item.name)
    if (name) mention.name = name
    out.push(mention)
  }
  return out
}
