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
import {
  acquireInstanceLock,
  acquireInstanceLockWithEviction,
  releaseInstanceLock,
} from './instance-lock'

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

/** One reply within a fetched document-comment thread. */
export interface FeishuDocCommentReply {
  /** reply_id of this reply; `''` when Feishu omitted it. */
  replyId: string
  /** open_id of the reply's author. */
  authorId: string
  /** Raw Feishu rich-content elements of the reply body, rendered by the handler. */
  elements: unknown[]
}

/**
 * A document comment and its reply thread, fetched to enrich a comment event.
 *
 * The `drive.notice.comment_add_v1` payload carries only the comment's ids, so
 * the comment text is fetched separately — this is the fetched result.
 */
export interface FeishuDocComment {
  /** False for a comment anchored to a text selection; `quote` then holds it. */
  isWhole: boolean
  /** The selected text a local-selection comment is anchored to; `''` otherwise. */
  quote: string
  /** The comment's replies, oldest first. */
  replies: FeishuDocCommentReply[]
}

/** A document's human-readable identity, fetched to render a comment event. */
export interface FeishuDocMeta {
  /** Document title. */
  title: string
  /** Browser URL of the document. */
  url: string
}

/** Document types the drive file-comment API serves; others have no comment API. */
const COMMENT_FILE_TYPES = ['doc', 'docx', 'sheet', 'file'] as const
type CommentFileType = (typeof COMMENT_FILE_TYPES)[number]

/** Narrow an event's file_type to one the file-comment API accepts, or `undefined`. */
function asCommentFileType(fileType: string): CommentFileType | undefined {
  return (COMMENT_FILE_TYPES as readonly string[]).includes(fileType)
    ? (fileType as CommentFileType)
    : undefined
}

/**
 * One comment as `drive.v1.fileComment.batchQuery` returns it — only the
 * fields the channel reads. The SDK's response type carries more; this is the
 * structural subset `commentFromBatchQuery` decodes, and the shape a unit
 * test builds a fixture against.
 */
interface RawCommentItem {
  comment_id?: string
  is_whole?: boolean
  quote?: string
  reply_list?: {
    replies?: Array<{
      reply_id?: string
      user_id?: string
      content?: { elements?: unknown[] }
    }>
  }
}

/**
 * Pick the comment with `commentId` out of a `fileComment.batchQuery` response
 * and shape it into a `FeishuDocComment`. Returns `null` when the response
 * carried no such comment. Pure: no I/O, never throws — exported so the decode
 * is unit-tested without a live Feishu connection.
 */
export function commentFromBatchQuery(
  items: RawCommentItem[],
  commentId: string,
): FeishuDocComment | null {
  const item = items.find((c) => c.comment_id === commentId)
  if (!item) return null
  const replies: FeishuDocCommentReply[] = (item.reply_list?.replies ?? []).map((reply) => ({
    replyId: reply.reply_id ?? '',
    authorId: reply.user_id ?? '',
    elements: reply.content?.elements ?? [],
  }))
  return { isWhole: item.is_whole ?? true, quote: item.quote ?? '', replies }
}

/** Document types the drive metadata API serves. */
const META_DOC_TYPES = [
  'doc',
  'docx',
  'sheet',
  'bitable',
  'mindnote',
  'file',
  'wiki',
  'folder',
  'synced_block',
  'slides',
] as const
type MetaDocType = (typeof META_DOC_TYPES)[number]

/** Narrow an event's file_type to one the metadata API accepts, or `undefined`. */
function asMetaDocType(fileType: string): MetaDocType | undefined {
  return (META_DOC_TYPES as readonly string[]).includes(fileType)
    ? (fileType as MetaDocType)
    : undefined
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
  /**
   * Add an emoji reaction to a message and return the reaction_id Feishu
   * assigned. That id is what `removeReaction` needs to take the same reaction
   * back off; Feishu can omit it, in which case an empty string is returned.
   */
  addReaction(messageId: string, emoji: string): Promise<string>
  /**
   * Remove a reaction from a message, identified by the reaction_id that
   * `addReaction` returned. Feishu only lets the app that added a reaction
   * remove it, so this is always paired with a prior `addReaction` from the
   * same channel.
   */
  removeReaction(messageId: string, reactionId: string): Promise<void>
  /** Replace the text of a message the bot previously sent. */
  editText(messageId: string, text: string): Promise<void>
  /**
   * Fetch one document comment and its reply thread. The comment-add event
   * payload carries no comment text, so the doc-comment handler calls this to
   * fill it in. Best-effort: returns `null` for a file type with no comment
   * API or on any API failure, and never throws — a failure degrades the
   * notification rather than dropping the event.
   */
  fetchDocComment(
    fileToken: string,
    fileType: string,
    commentId: string,
  ): Promise<FeishuDocComment | null>
  /**
   * Fetch a document's title and URL, so a comment notification names the
   * document a human would recognize. Best-effort: returns `null` for a file
   * type with no metadata API or on any API failure, and never throws.
   */
  fetchDocMeta(fileToken: string, fileType: string): Promise<FeishuDocMeta | null>
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
      // Exactly one process per machine opens the inbound WebSocket. A freshly
      // started server takes the lock when it is free, and evicts an older
      // channel server still holding it from a previous plugin version — so a
      // plugin upgrade takes effect at once instead of waiting out the old
      // server. Every other instance stands by and polls, so a crashed holder
      // is taken over rather than leaving the channel dark.
      const acquired = await acquireInstanceLockWithEviction(lockPath)
      if (acquired.acquired) {
        holdsLock = true
        logConnection(
          acquired.evicted
            ? 'evicted an older channel server and took over the inbound connection'
            : 'single-instance lock acquired — opening the inbound connection',
        )
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

    async addReaction(messageId: string, emoji: string): Promise<string> {
      const res = await client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      })
      return res.data?.reaction_id ?? ''
    },

    async removeReaction(messageId: string, reactionId: string): Promise<void> {
      await client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      })
    },

    async editText(messageId: string, text: string): Promise<void> {
      await client.im.message.update({
        path: { message_id: messageId },
        data: { msg_type: 'text', content: JSON.stringify({ text }) },
      })
    },

    async fetchDocComment(
      fileToken: string,
      fileType: string,
      commentId: string,
    ): Promise<FeishuDocComment | null> {
      // The file-comment API only serves a subset of document types; for any
      // other type there is no comment to fetch, so skip the call outright.
      const ct = asCommentFileType(fileType)
      if (!ct) return null
      try {
        // `batchQuery` resolves a comment by id and serves both
        // whole-document and local-selection comments. The single-comment
        // `get` endpoint serves only whole-document comments — it returns
        // "not exist" for a comment anchored to a text selection, which is
        // most document comments.
        const res = await client.drive.fileComment.batchQuery({
          path: { file_token: fileToken },
          // Resolve reply authors to open_id, so they match the open_id the
          // event carries and the sender_id of chat messages.
          params: { file_type: ct, user_id_type: 'open_id' },
          data: { comment_ids: [commentId] },
        })
        return commentFromBatchQuery(res.data?.items ?? [], commentId)
      } catch (err) {
        console.error(
          `[feishu-channel] could not fetch comment ${commentId} on ${fileToken}:`,
          err,
        )
        return null
      }
    },

    async fetchDocMeta(fileToken: string, fileType: string): Promise<FeishuDocMeta | null> {
      const dt = asMetaDocType(fileType)
      if (!dt) return null
      try {
        const res = await client.drive.meta.batchQuery({
          data: { request_docs: [{ doc_token: fileToken, doc_type: dt }], with_url: true },
        })
        const meta = res.data?.metas?.[0]
        if (!meta) return null
        return { title: meta.title ?? '', url: meta.url ?? '' }
      } catch (err) {
        console.error(`[feishu-channel] could not fetch metadata for ${fileToken}:`, err)
        return null
      }
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
