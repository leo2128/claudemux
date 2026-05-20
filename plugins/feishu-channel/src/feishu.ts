/**
 * The Feishu platform boundary.
 *
 * Everything that talks to Feishu — the inbound long-lived WebSocket and the
 * outbound message API — sits behind the `FeishuTransport` interface. The
 * channel server depends only on that interface, so its inbound and outbound
 * wiring can be exercised against an injected fake with no live connection.
 *
 * `createFeishuTransport` is the real implementation, wrapping the official
 * `@larksuiteoapi/node-sdk`. `normalizeInboundEvent` is a pure function that
 * reshapes a raw `im.message.receive_v1` payload into the event the rest of
 * the channel consumes — it is the unit-tested part of this module.
 */

import * as lark from '@larksuiteoapi/node-sdk'
import type { Mention } from './types'

/** A normalized inbound Feishu message, as the channel server consumes it. */
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

/** Outcome of an outbound send. */
export interface FeishuSendResult {
  /** message_id of the sent message, when Feishu reported one. */
  messageId?: string
}

/** Invoked for every inbound message the connection delivers. */
export type InboundHandler = (event: FeishuInboundEvent) => void | Promise<void>

/**
 * The platform boundary the channel server depends on. The real implementation
 * (`createFeishuTransport`) wraps the Feishu SDK; tests inject a fake so the
 * server's inbound and outbound wiring runs without a live Feishu connection.
 */
export interface FeishuTransport {
  /**
   * open_id of the bot itself, for group mention-gating. `undefined` until
   * `start` has resolved it (and stays `undefined` if resolution failed).
   */
  readonly botOpenId: string | undefined
  /** Open the long-lived connection and route inbound messages to `handler`. */
  start(handler: InboundHandler): Promise<void>
  /**
   * Send a text message into a chat. Routed by `chat_id`, never by a
   * message_id, so a forged reply target cannot redirect the message into an
   * unrelated conversation.
   */
  sendText(chatId: string, text: string): Promise<FeishuSendResult>
  /** Add an emoji reaction to a message. */
  addReaction(messageId: string, emoji: string): Promise<void>
  /** Replace the text of a message the bot previously sent. */
  editText(messageId: string, text: string): Promise<void>
  /** Close the connection and release every resource it holds. */
  close(): Promise<void>
}

/** Feishu self-built-app credentials. */
export interface FeishuCredentials {
  appId: string
  appSecret: string
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object'
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * The real Feishu transport, wrapping the official SDK.
 *
 * Inbound: a `WSClient` opens a long-lived WebSocket and an `EventDispatcher`
 * routes `im.message.receive_v1` events through `normalizeInboundEvent` to the
 * supplied handler. Outbound: a `Client` calls the `im` message API; it manages
 * the `tenant_access_token` internally. This implementation is not unit-tested
 * — it needs a live Feishu app — so the testable logic stays in pure helpers.
 */
export function createFeishuTransport(creds: FeishuCredentials): FeishuTransport {
  const client = new lark.Client({ appId: creds.appId, appSecret: creds.appSecret })
  let wsClient: lark.WSClient | undefined
  let resolvedBotOpenId: string | undefined

  return {
    get botOpenId(): string | undefined {
      return resolvedBotOpenId
    },

    async start(handler: InboundHandler): Promise<void> {
      resolvedBotOpenId = await resolveBotOpenId(client)
      const dispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: unknown): Promise<void> => {
          const event = normalizeInboundEvent(data)
          if (event) await handler(event)
        },
      })
      wsClient = new lark.WSClient({ appId: creds.appId, appSecret: creds.appSecret })
      await wsClient.start({ eventDispatcher: dispatcher })
    },

    async sendText(chatId: string, text: string): Promise<FeishuSendResult> {
      const res = await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
      })
      return { messageId: res.data?.message_id }
    },

    async addReaction(messageId: string, emoji: string): Promise<void> {
      await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      })
    },

    async editText(messageId: string, text: string): Promise<void> {
      await client.im.message.update({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text }) },
      })
    },

    async close(): Promise<void> {
      try {
        wsClient?.close()
      } catch {
        // A close on an already-closed socket is not an error worth surfacing.
      }
      wsClient = undefined
    },
  }
}

/**
 * Resolve the bot's own open_id, needed for group mention-gating. The SDK does
 * not expose a bot-info method, so this calls the raw endpoint through the
 * client (which still attaches the token). Best-effort: a failure leaves the
 * open_id unknown rather than blocking startup.
 */
async function resolveBotOpenId(client: lark.Client): Promise<string | undefined> {
  try {
    const res = await client.request<{ bot?: { open_id?: string } }>({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
    })
    return res.bot?.open_id
  } catch {
    return undefined
  }
}
