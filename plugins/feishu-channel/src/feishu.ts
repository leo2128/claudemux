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
 *
 * Only one server process per machine opens the inbound WebSocket. `start`
 * acquires a single-instance lock (see `./instance-lock`); a process that
 * loses the lock stands by and polls, so a crashed holder is taken over.
 */

import * as lark from '@larksuiteoapi/node-sdk'

import {
  connectionErrorLogLine,
  reconnectedLogLine,
  reconnectingLogLine,
  startupTimeoutLogLine,
} from './connection'
import { acquireInstanceLock, releaseInstanceLock } from './instance-lock'

/** Cap on a single WebSocket handshake before it is aborted into a retry. */
const WS_HANDSHAKE_TIMEOUT_MS = 15_000

/**
 * How long the initial connection is given to come up before the channel
 * stops it. Long enough to absorb a brief blip and the SDK's own early
 * retries; past it, an unreachable Feishu would otherwise retry in a tight
 * loop, so the channel cuts the attempt off.
 */
const WS_STARTUP_GRACE_MS = 30_000

/**
 * How often a stood-by process retries the single-instance lock. Sets the
 * worst-case gap between a holder crashing and a sibling taking over the
 * inbound connection.
 */
const STANDBY_POLL_MS = 30_000

/**
 * A Lark-SDK logger that writes every line to stderr.
 *
 * The MCP stdio transport reserves stdout for the JSON-RPC stream. The SDK's
 * default logger writes to stdout, which corrupts that stream: the client
 * rejects the non-JSON lines, and a log line emitted while a notification is
 * being written can break the notification's frame and drop a real inbound
 * message. Routing the SDK's logger to stderr keeps stdout exclusively
 * JSON-RPC, while the SDK's diagnostics stay visible in the server's log.
 */
const sdkLogger = {
  error: (...msg: unknown[]) => console.error('[feishu-sdk]', ...msg),
  warn: (...msg: unknown[]) => console.error('[feishu-sdk]', ...msg),
  info: (...msg: unknown[]) => console.error('[feishu-sdk]', ...msg),
  debug: (...msg: unknown[]) => console.error('[feishu-sdk]', ...msg),
  trace: (...msg: unknown[]) => console.error('[feishu-sdk]', ...msg),
}

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
  /**
   * Take part in the single-instance election. The process that wins the lock
   * opens the long-lived connection and dispatches inbound events via
   * `routes`; a process that loses stands by and polls to take over.
   */
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
export function createFeishuTransport(
  creds: FeishuCredentials,
  lockPath: string,
): FeishuTransport {
  const client = new lark.Client({
    appId: creds.appId,
    appSecret: creds.appSecret,
    logger: sdkLogger,
  })
  let wsClient: lark.WSClient | undefined
  let resolvedBotOpenId: string | undefined
  /** Poll handle while standing by for the lock; `undefined` once primary. */
  let standbyTimer: ReturnType<typeof setInterval> | undefined
  /** True once this process holds the single-instance lock. */
  let holdsLock = false

  /**
   * Open the inbound WebSocket and dispatch events through `routes`. Called
   * only by the process holding the single-instance lock — at startup if it
   * won the lock outright, or later from the standby poll once a previous
   * holder released or crashed.
   */
  async function openInbound(routes: InboundRoutes): Promise<void> {
    resolvedBotOpenId = await resolveBotOpenId(client)
    const dispatcher = new lark.EventDispatcher({ logger: sdkLogger }).register(routes)

    // Resolves the first time the connection reaches `ready`; the startup
    // watchdog below races against it.
    let markReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => {
      markReady = resolve
    })

    const ws = new lark.WSClient({
      appId: creds.appId,
      appSecret: creds.appSecret,
      // Route the SDK's own logging to stderr — see `sdkLogger`.
      logger: sdkLogger,
      // Bound a stuck WebSocket handshake so it fails into a retry rather
      // than holding a stuck DNS / NAT path open indefinitely.
      handshakeTimeoutMs: WS_HANDSHAKE_TIMEOUT_MS,
      // autoReconnect stays on: an established connection that drops should
      // self-heal. The callbacks make every step of that loop visible, so a
      // failing connection is observable instead of a silent retry loop.
      autoReconnect: true,
      onReady: () => {
        logConnection('Feishu WebSocket connection is ready')
        markReady()
      },
      onReconnecting: () => logConnection(reconnectingLogLine()),
      onReconnected: () => logConnection(reconnectedLogLine()),
      onError: (err) => logConnection(connectionErrorLogLine(err)),
    })
    wsClient = ws

    void ws.start({ eventDispatcher: dispatcher }).catch((err: unknown) => {
      logConnection(connectionErrorLogLine(err))
    })

    // The SDK retries pullConnectConfig with no delay until it first
    // succeeds — it has no server-provided reconnect interval yet — so a
    // Feishu that is unreachable at startup spins a tight retry loop.
    // Give the initial connection a grace window; if it is still not up,
    // stop it so the loop does not run unbounded and unobserved.
    const cameUp = await raceConnectionReady(ready)
    if (!cameUp) {
      const gaveUp = ws.getConnectionStatus().state === 'failed'
      logConnection(startupTimeoutLogLine(WS_STARTUP_GRACE_MS, gaveUp))
      ws.close()
    }
  }

  return {
    get botOpenId(): string | undefined {
      return resolvedBotOpenId
    },

    async start(routes: InboundRoutes): Promise<void> {
      // Exactly one process per machine opens the inbound WebSocket. The lock
      // holder connects; every other instance stands by and polls, so a
      // crashed holder is taken over rather than leaving the channel dark.
      if (acquireInstanceLock(lockPath).acquired) {
        holdsLock = true
        logConnection('single-instance lock acquired — opening the inbound connection')
        await openInbound(routes)
        return
      }

      logConnection(
        'another channel instance holds the inbound connection — standing by as secondary',
      )
      standbyTimer = setInterval(() => {
        if (!acquireInstanceLock(lockPath).acquired) return
        holdsLock = true
        if (standbyTimer) {
          clearInterval(standbyTimer)
          standbyTimer = undefined
        }
        logConnection('single-instance lock taken over — opening the inbound connection')
        void openInbound(routes)
      }, STANDBY_POLL_MS)
      // The poll must not by itself keep the process alive.
      ;(standbyTimer as { unref?: () => void }).unref?.()
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
      if (standbyTimer) {
        clearInterval(standbyTimer)
        standbyTimer = undefined
      }
      try {
        wsClient?.close()
      } catch (err) {
        // A close on an already-closed socket is expected; anything else
        // (e.g. the SDK's close surface changed) is worth a diagnostic line.
        console.error('[feishu-channel] error while closing the Feishu WebSocket:', err)
      }
      wsClient = undefined
      // Release the single-instance lock so a standing-by sibling can take
      // over. `releaseInstanceLock` removes the file only when this process
      // is the recorded holder, so a secondary calling `close()` cannot
      // disturb the real holder's lock.
      if (holdsLock) {
        releaseInstanceLock(lockPath)
        holdsLock = false
      }
    },
  }
}

/** How many times to try resolving the bot's open_id before giving up. */
const BOT_INFO_ATTEMPTS = 3

/**
 * Resolve the bot's own open_id, needed for group mention-gating. The SDK does
 * not expose a bot-info method, so this calls the raw endpoint through the
 * client (which still attaches the token).
 *
 * Best-effort: a failure leaves the open_id unknown rather than blocking
 * startup — but it is not silent. An unknown open_id makes `isBotMentioned`
 * never match, so every mention-gated group would drop every message; each
 * failure is logged with that consequence spelled out, and a transient error
 * is retried a few times before the channel gives up.
 */
async function resolveBotOpenId(client: lark.Client): Promise<string | undefined> {
  for (let attempt = 1; attempt <= BOT_INFO_ATTEMPTS; attempt++) {
    try {
      const res = await client.request<{ bot?: { open_id?: string } }>({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      })
      const openId = res.bot?.open_id
      if (openId) return openId
      // A well-formed response that simply lacks the field will not improve
      // on retry — stop here rather than spend the remaining attempts.
      console.error(
        '[feishu-channel] bot info response carried no open_id — groups that ' +
          'require an @-mention will drop every message until the channel restarts',
      )
      return undefined
    } catch (err) {
      if (attempt < BOT_INFO_ATTEMPTS) {
        await delay(attempt * 500)
        continue
      }
      console.error(
        `[feishu-channel] could not resolve the bot open_id after ${BOT_INFO_ATTEMPTS} ` +
          'attempts — groups that require an @-mention will drop every message ' +
          'until the channel restarts:',
        err,
      )
      return undefined
    }
  }
  return undefined
}

/** Resolve after `ms` milliseconds — the backoff between bot-info attempts. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Write a timestamped connection-lifecycle line to the channel's stderr log. */
function logConnection(line: string): void {
  console.error(`[feishu-channel] ${new Date().toISOString()} ${line}`)
}

/**
 * Resolve `true` if `ready` settles within the startup grace window, `false`
 * if the window elapses first. The timer is cleared on the winning path so it
 * does not keep the process alive after the race is decided.
 */
function raceConnectionReady(ready: Promise<void>): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), WS_STARTUP_GRACE_MS)
    void ready.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
