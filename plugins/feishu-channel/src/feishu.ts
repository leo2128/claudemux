/**
 * The Feishu platform boundary.
 *
 * Everything that talks to Feishu — the inbound long-lived WebSocket and the
 * outbound message API — sits behind the `FeishuTransport` interface. The
 * channel server depends only on that interface, so its wiring can be
 * exercised against an injected fake with no live connection.
 *
 * The transport is event-type agnostic. `start` is handed a route table
 * mapping each Feishu event_type to a callback and registers every entry
 * with the SDK's event dispatcher; decoding a specific event's payload is the
 * job of that event's handler, not this module. Adding a new event type to
 * the channel therefore never touches this file.
 */

import * as lark from '@larksuiteoapi/node-sdk'

/** Outcome of an outbound send. */
export interface FeishuSendResult {
  /** message_id of the sent message, when Feishu reported one. */
  messageId?: string
}

/**
 * Inbound event routes: Feishu event_type → callback. The server builds this
 * from the event registry; the transport registers every entry with the
 * SDK's event dispatcher. The callback receives the raw event payload exactly
 * as the SDK delivered it.
 */
export type InboundRoutes = Record<string, (raw: unknown) => void | Promise<void>>

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
  /** Open the long-lived connection and dispatch inbound events via `routes`. */
  start(routes: InboundRoutes): Promise<void>
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
 * The real Feishu transport, wrapping the official SDK.
 *
 * Inbound: a `WSClient` opens a long-lived WebSocket and an `EventDispatcher`
 * routes every subscribed event_type to its callback. Outbound: a `Client`
 * calls the `im` message API; it manages the `tenant_access_token` internally.
 * This implementation is not unit-tested — it needs a live Feishu app — so the
 * testable logic stays in the pure event handlers.
 */
export function createFeishuTransport(creds: FeishuCredentials): FeishuTransport {
  const client = new lark.Client({ appId: creds.appId, appSecret: creds.appSecret })
  let wsClient: lark.WSClient | undefined
  let resolvedBotOpenId: string | undefined

  return {
    get botOpenId(): string | undefined {
      return resolvedBotOpenId
    },

    async start(routes: InboundRoutes): Promise<void> {
      resolvedBotOpenId = await resolveBotOpenId(client)
      const dispatcher = new lark.EventDispatcher({}).register(routes)
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
