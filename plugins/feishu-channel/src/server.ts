/**
 * The Feishu channel MCP server.
 *
 * This module assembles the channel: it declares the `claude/channel`
 * capability, exposes the outbound tools, and runs the inbound pipeline —
 * which is now a thin dispatcher over an `EventRegistry`. Each Feishu event
 * type is a registered handler (see `./events` and `./handlers/`); the core
 * only resolves a handler by event_type, runs it, and delivers its result.
 *
 * The channel logic lives in `createChannelCore`, which depends only on a
 * `FeishuTransport` and a notifier callback — so the inbound and outbound
 * paths are unit-testable against fakes, with no MCP stdio and no live
 * Feishu connection. `main` is the thin process entry point that wires the
 * core to a real MCP `Server`, a real transport, and graceful shutdown.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

import { EventRegistry } from './events'
import type { ChannelDelivery, HandlerContext } from './events'
import type { FeishuCredentials, FeishuTransport, InboundRoutes } from './feishu'
import { createFeishuTransport } from './feishu'
import { createDocCommentHandler } from './handlers/doc-comment'
import { createImMessageHandler } from './handlers/im-message'
import { asString, isRecord } from './json'
import { listObservedBots } from './observed-bots-store'
import { generatePairingCode } from './pairing'
import { accessFile, envFile, lockFile, stateDir } from './paths'
import { ShutdownCoordinator } from './shutdown'

/** Version advertised to Claude Code in the MCP `initialize` handshake. */
const SERVER_VERSION = '0.1.0'

/** The JSON-RPC method that carries an inbound event to the Claude session. */
const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel'

/**
 * The emoji the channel reacts with to mark an inbound chat message as
 * received into the Claude session. `GLANCE` is Feishu's 👀 emoji — it reads
 * as "seen, being looked at", which is exactly the signal the sender wants:
 * their message landed and Claude is on it. The channel adds this reaction
 * once a message reaches the session and removes it once Claude replies into
 * that chat.
 */
export const RECEIVED_REACTION_EMOJI = 'GLANCE'

/** Pushes one inbound event to the Claude session. */
export type ChannelNotifier = (
  content: string,
  meta: Record<string, string>,
) => void | Promise<void>

/** Everything `createChannelCore` needs; the platform and clock are injectable. */
export interface ChannelCoreDeps {
  /** The Feishu platform boundary — a real transport or a test fake. */
  transport: FeishuTransport
  /** Path to access.json, the persisted access-control policy. */
  accessFile: string
  /**
   * Root directory for all channel state files. Defaults to `stateDir()`.
   * Tests point this at a temp directory to avoid touching real state.
   */
  baseDir?: string
  /** Delivers a gated inbound event to the Claude session. */
  notify: ChannelNotifier
  /** Injected clock (epoch millis); defaults to `Date.now`. */
  now?: () => number
  /** Injected pairing-code generator; defaults to `generatePairingCode`. */
  generateCode?: () => string
  /** Reports a recoverable error; defaults to logging to stderr. */
  logError?: (message: string, err?: unknown) => void
  /**
   * Reports a low-severity diagnostic; defaults to logging to stderr only
   * when `FEISHU_CHANNEL_DEBUG` is set, so routine drops do not spam logs.
   */
  logDebug?: (message: string) => void
  /**
   * Reports an inbound-pipeline milestone — event received, delivered, or not
   * delivered. Defaults to a timestamped stderr line and is always on: these
   * lines trace where an inbound message went, and they are proportional to
   * real traffic rather than to a noisy drop loop.
   */
  logInfo?: (message: string) => void
}

/** The channel's testable core: the inbound dispatcher and the outbound tools. */
export interface ChannelCore {
  /** The MCP tool definitions this channel exposes. */
  readonly tools: Tool[]
  /** Inbound route table — event_type → callback, handed to `transport.start`. */
  readonly routes: InboundRoutes
  /** Dispatch one raw Feishu event of `eventType` through its handler. */
  handleEvent(eventType: string, raw: unknown): Promise<void>
  /** Execute one outbound MCP tool call. */
  handleTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>
}

/** The outbound tools the channel exposes to Claude. */
const CHANNEL_TOOLS: Tool[] = [
  {
    name: 'reply',
    description:
      'Send a message into a Feishu chat. The text is rendered as Markdown by Feishu — use **bold**, *italic*, `inline code`, fenced ``` code blocks, bulleted and numbered lists, and [links](https://example.com) where they help readability. To @-mention a user inline, write <@open_id> (e.g. "<@ou_abc123> 请帮忙看一下"). Pass the chat_id from the <channel> tag of the message you are answering.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'Target chat_id, copied verbatim from the inbound <channel> tag.',
        },
        text: {
          type: 'string',
          description:
            'Message body in Markdown. Supports bold, italic, links, ordered and unordered lists, inline code, and fenced code blocks. To @-mention a Feishu user inline, write <@open_id> anywhere in the text (e.g. "<@ou_abc123> 任务完成" or "请 <@ou_abc123> 帮忙 review").',
        },
      },
      required: ['chat_id', 'text'],
    },
  },
  {
    name: 'react',
    description: 'Add an emoji reaction to a Feishu message.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'message_id from the inbound <channel> tag.',
        },
        emoji: {
          type: 'string',
          description: 'Feishu emoji_type, e.g. THUMBSUP, OK, DONE.',
        },
      },
      required: ['message_id', 'emoji'],
    },
  },
  {
    name: 'edit_message',
    description:
      'Replace the content of a message this channel previously sent. The new text is rendered as Markdown, same as `reply` — including <@open_id> @-mention support.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'message_id of the bot message to edit.',
        },
        text: {
          type: 'string',
          description:
            'New message body in Markdown; same formatting rules and <@open_id> @-mention syntax as `reply`.',
        },
      },
      required: ['message_id', 'text'],
    },
  },
]

/**
 * Build the channel core. The returned object dispatches inbound events
 * through the event registry and runs outbound tool calls; it never touches
 * MCP stdio directly, so a test can drive both paths with a fake transport
 * and a capturing notifier.
 */
export function createChannelCore(deps: ChannelCoreDeps): ChannelCore {
  const now = deps.now ?? Date.now
  const generateCode = deps.generateCode ?? generatePairingCode
  const logError = deps.logError ?? defaultLogError
  const logDebug = deps.logDebug ?? defaultLogDebug
  const logInfo = deps.logInfo ?? defaultLogInfo
  const baseDir = deps.baseDir ?? stateDir()

  const ctx: HandlerContext = {
    transport: deps.transport,
    accessFile: deps.accessFile,
    baseDir,
    now,
    generateCode,
    logError,
    logDebug,
  }

  // Every Feishu event type the channel reacts to is a registered handler.
  // A new event type is added by registering one more handler here.
  const registry = new EventRegistry()
    .register(createImMessageHandler())
    .register(createDocCommentHandler())

  const routes: InboundRoutes = {}
  for (const eventType of registry.eventTypes()) {
    routes[eventType] = (raw: unknown) => {
      logInfo(`inbound ${eventType} received (message ${inboundMessageId(raw)})`)
      return handleEvent(eventType, raw)
    }
  }

  /**
   * message_id → the chat it belongs to and the reaction_id of its "received"
   * indicator, for every inbound chat message delivered to the session and
   * still awaiting a reply. Held in memory, not on disk, on purpose: the
   * process that owns the inbound connection is the same one whose `reply`
   * tool answers the session it feeds, so a process-local map is consistent,
   * and a restart discards the Claude conversation and this map together —
   * persisting it would only preserve indicators for context that is gone.
   */
  const pendingReactions = new Map<string, { chatId: string; reactionId: string }>()

  async function handleEvent(eventType: string, raw: unknown): Promise<void> {
    const messageId = inboundMessageId(raw)
    const handler = registry.get(eventType)
    if (!handler) {
      logInfo(`${eventType} ignored — no registered handler`)
      return
    }

    let delivery: ChannelDelivery | null
    try {
      delivery = await handler.handle(raw, ctx)
    } catch (err) {
      logError(`failed to handle a ${eventType} event`, err)
      return
    }
    if (!delivery) {
      // A null delivery is an access-gate drop, a pairing prompt, or an event
      // with no forwardable content. The specific reason, when there is one,
      // is logged by the handler through `logDebug`.
      logInfo(`${eventType} not delivered — gated out, paired, or empty (message ${messageId})`)
      return
    }

    logInfo(`${eventType} gated through — delivering (message ${messageId})`)
    try {
      const content = withAvailableBots(delivery.content, delivery.meta, ctx)
      await deps.notify(content, delivery.meta)
      // The event is now in the session's context — mark the source message
      // as received so the Feishu sender sees it landed. `markReceived`
      // swallows its own failures, so it never reaches the catch below.
      await markReceived(delivery.meta)
    } catch (err) {
      logError(`failed to deliver a ${eventType} notification`, err)
    }
  }

  /**
   * Mark a just-delivered message as received: add the "received" reaction on
   * Feishu and remember its reaction_id so a later reply can take it back off.
   * Only chat messages carry the indicator — a doc comment is not an IM
   * message, and the message-reaction API has nothing to act on for it.
   * Best-effort: it catches its own failures so a reaction problem is logged
   * and never looks like a delivery failure to the caller.
   */
  async function markReceived(meta: Record<string, string>): Promise<void> {
    if (meta.kind !== 'message') return
    const messageId = meta.message_id
    const chatId = meta.chat_id
    if (!messageId || !chatId) return
    try {
      const reactionId = await deps.transport.addReaction(messageId, RECEIVED_REACTION_EMOJI)
      if (!reactionId) {
        logError(
          `Feishu returned no reaction_id for the received reaction on message ` +
            `${messageId}; it cannot be cleared when Claude replies`,
        )
        return
      }
      pendingReactions.set(messageId, { chatId, reactionId })
    } catch (err) {
      logError(`failed to add the received reaction to message ${messageId}`, err)
    }
  }

  /**
   * Clear the "received" reaction from every message in a chat that is still
   * awaiting a reply — called once a reply has been sent into that chat, since
   * those messages are now answered. A `reply` carries only a chat_id, while a
   * reaction lives on a specific message_id, so the whole chat's pending set
   * is cleared: anything outstanding when Claude answers the chat is treated
   * as addressed by that answer. Each removal is best-effort and a message is
   * dropped from the map even when its removal fails, so a reaction_id Feishu
   * will not accept is not retried on every later reply.
   */
  async function clearReceived(chatId: string): Promise<void> {
    const pending = [...pendingReactions].filter(([, record]) => record.chatId === chatId)
    for (const [messageId, record] of pending) {
      pendingReactions.delete(messageId)
      try {
        await deps.transport.removeReaction(messageId, record.reactionId)
      } catch (err) {
        logError(`failed to remove the received reaction from message ${messageId}`, err)
      }
    }
  }

  async function handleTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    try {
      switch (name) {
        case 'reply': {
          const chatId = requireString(args, 'chat_id')
          const text = requireString(args, 'text')
          // The transport renders the markdown source into v2 interactive
          // cards (`./render`): headings become the card title, GFM tables
          // become `tag: table` components, every other block becomes a
          // `tag: markdown` element. A body too large for one card produces
          // several messages; their ids come back in `messageIds`, in send
          // order, so the summary names how many landed.
          const result = await deps.transport.sendText(chatId, text)
          // The chat has been answered — take the "received" indicator back
          // off every message in it that was waiting for this reply. Reached
          // only after the send succeeds, so a failed reply leaves the
          // indicator in place.
          await clearReceived(chatId)
          const ids = result.messageIds
          const summary =
            ids.length <= 1
              ? `Sent to ${chatId}${ids[0] ? ` as ${ids[0]}` : ''}.`
              : `Sent to ${chatId} in ${ids.length} messages.`
          return toolText(summary)
        }
        case 'react': {
          const messageId = requireString(args, 'message_id')
          const emoji = requireString(args, 'emoji')
          await deps.transport.addReaction(messageId, emoji)
          return toolText(`Reacted ${emoji} to ${messageId}.`)
        }
        case 'edit_message': {
          const messageId = requireString(args, 'message_id')
          const text = requireString(args, 'text')
          await deps.transport.editText(messageId, text)
          return toolText(`Edited ${messageId}.`)
        }
        default:
          return toolText(`Unknown tool: ${name}`, true)
      }
    } catch (err) {
      return toolText(err instanceof Error ? err.message : String(err), true)
    }
  }

  return { tools: CHANNEL_TOOLS, routes, handleEvent, handleTool }
}

/**
 * Build the JSON-RPC notification that carries one inbound event to the Claude
 * session. Exported so the assembly — the method name and the `content` /
 * `meta` param shape — is covered without a live MCP connection.
 */
export function channelNotification(
  content: string,
  meta: Record<string, string>,
): { method: string; params: { content: string; meta: Record<string, string> } } {
  return { method: CHANNEL_NOTIFICATION_METHOD, params: { content, meta } }
}

/** Read a required non-empty string argument, throwing a clear error otherwise. */
function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing or empty required argument: ${key}`)
  }
  return value
}

/** Wrap text in an MCP tool result, optionally flagged as an error. */
function toolText(text: string, isError = false): CallToolResult {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] }
}

/** Prefix for every channel log line: the fixed tag and an ISO-8601 timestamp. */
function logPrefix(): string {
  return `[feishu-channel] ${new Date().toISOString()}`
}

function defaultLogError(message: string, err?: unknown): void {
  if (err === undefined) {
    console.error(`${logPrefix()} ${message}`)
  } else {
    console.error(`${logPrefix()} ${message}`, err)
  }
}

/** Default inbound-pipeline logger — a timestamped stderr line, always on. */
function defaultLogInfo(message: string): void {
  console.error(`${logPrefix()} ${message}`)
}

/**
 * Default diagnostic logger. Access-control drops are the answer to "why did
 * my message not arrive", so they are worth logging — but a busy mention-gated
 * group drops constantly, so the line is emitted only when `FEISHU_CHANNEL_DEBUG`
 * is set rather than on by default.
 */
function defaultLogDebug(message: string): void {
  if (process.env.FEISHU_CHANNEL_DEBUG) {
    console.error(`${logPrefix()} ${message}`)
  }
}

/**
 * Best-effort message_id of a raw inbound event, used to correlate log lines.
 * Tolerates either an `{ event: ... }` envelope or the event body alone, and
 * returns a placeholder for an event type that carries no message_id.
 */
function inboundMessageId(raw: unknown): string {
  if (!isRecord(raw)) return '(unknown)'
  const event = isRecord(raw.event) ? raw.event : raw
  const message = isRecord(event.message) ? event.message : {}
  return asString(message.message_id) || '(no message_id)'
}

/**
 * Append an `<available_bots>` block to the delivery content when the message
 * arrived in a group and there are known peer bots for that chat.
 *
 * Only fires for group messages (p2p has no peer bots), filters out self (this
 * bot's open_id), and is a no-op when the store is empty or missing.
 */
function withAvailableBots(
  content: string,
  meta: Record<string, string>,
  ctx: HandlerContext,
): string {
  if (meta.chat_type !== 'group') return content
  const chatId = meta.chat_id
  if (!chatId) return content

  const bots = listObservedBots(ctx.baseDir, ctx.transport.appId, chatId)
  const external = bots.filter((b) => b.openId !== ctx.transport.botOpenId)
  if (external.length === 0) return content

  const lines = [
    '<available_bots>',
    ...external.map((b) => `  <bot name="${escapeXmlAttr(b.name)}" open_id="${escapeXmlAttr(b.openId)}" />`),
    '</available_bots>',
  ]
  return `${content}\n${lines.join('\n')}`
}

/** Escape the five XML special characters so they are safe inside an attribute value. */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Guidance injected into Claude's system prompt for this channel. */
const CHANNEL_INSTRUCTIONS = [
  'This MCP server is a Feishu (Lark) channel. Inbound Feishu events arrive as',
  '<channel source="feishu"> blocks; the `kind` attribute says which kind of event it is.',
  '',
  'kind="message" — a chat message. Attributes:',
  '- chat_id: the conversation the message came from; pass it to the `reply` tool to answer.',
  '- message_id: the specific message; pass it to `react` or `edit_message`.',
  '- chat_type: "p2p" for a direct message, "group" for a group chat.',
  '- sender_id: the Feishu open_id of the sender.',
  'Answer a Feishu user by calling `reply` with the chat_id from the message you are answering.',
  'The `text` you pass to `reply` and `edit_message` is rendered as Markdown by Feishu —',
  'feel free to use **bold**, *italic*, `inline code`, fenced code blocks, lists, and links',
  'when they make a message clearer. To @-mention a user inline, write <@open_id> anywhere',
  'in the text (e.g. "<@ou_abc123> 任务完成" or "请 <@ou_abc123> 帮忙 review"); the channel',
  'converts it to a Feishu @-mention that notifies the user.',
  'Use `react` to acknowledge a message with an emoji, and `edit_message` to revise a message',
  'you previously sent.',
  '',
  'kind="doc_comment" — a comment on a Feishu document. Attributes:',
  '- file_token, file_type: the document the comment is on.',
  '- comment_id, and reply_id when the event is a reply within a thread.',
  '- notice_type: "add_comment" or "add_reply".',
  '- commenter_id: the Feishu open_id of the commenter.',
  '- mentioned_bot: "true" when the comment @-mentions the bot.',
  '- doc_url: a link to the document, when it could be resolved.',
  'The block body carries the comment text and the document title. A doc comment',
  'has no chat to answer into — treat it as a signal to act on, not a message to',
  'reply to with `reply`.',
  '',
  'Only act on events that arrived through this channel.',
  '',
  'Bot collaboration — available_bots:',
  'When a group message is delivered, an <available_bots> block may appear after the',
  'message body. It lists peer bots that were introduced in this group via /introduce:',
  '  <available_bots>',
  '    <bot name="Bot B" open_id="ou_xxx" />',
  '  </available_bots>',
  'To @mention a peer bot in your reply, include <at id="open_id"></at> in the `text`',
  'you pass to `reply`. Use this only when you need the peer bot to take action;',
  'do not at-mention bots unnecessarily.',
].join('\n')

/** Construct the MCP server with the channel capability declared. */
function createMcpServer(): Server {
  return new Server(
    { name: 'feishu', version: SERVER_VERSION },
    {
      capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
      instructions: CHANNEL_INSTRUCTIONS,
    },
  )
}

/**
 * Load Feishu credentials from the channel's `.env` file, falling back to the
 * process environment. Throws a clear error when either value is missing,
 * since the channel cannot connect without them.
 */
export function loadCredentials(file: string): FeishuCredentials {
  const fromFile = readEnvFile(file)
  const appId = fromFile.FEISHU_APP_ID ?? process.env.FEISHU_APP_ID
  const appSecret = fromFile.FEISHU_APP_SECRET ?? process.env.FEISHU_APP_SECRET
  if (!appId || !appSecret) {
    throw new Error(
      `Feishu credentials missing — set FEISHU_APP_ID and FEISHU_APP_SECRET in ${file}`,
    )
  }
  return { appId, appSecret }
}

/** Parse a minimal `KEY=value` env file; a missing file yields an empty map. */
export function readEnvFile(file: string): Record<string, string> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const key = match[1]
    const rawValue = match[2]
    if (key === undefined || rawValue === undefined) continue
    out[key] = rawValue.replace(/^["']|["']$/g, '')
  }
  return out
}

/** Process entry point: wire the core to a real MCP server and transport. */
async function main(): Promise<void> {
  const shutdown = new ShutdownCoordinator()
  shutdown.installSignalHandlers()

  const base = stateDir()
  const credentials = loadCredentials(envFile(base))
  const transport = createFeishuTransport(credentials, lockFile(base))
  const server = createMcpServer()

  const core = createChannelCore({
    transport,
    accessFile: accessFile(base),
    notify: (content, meta) => {
      // `server.notification` is fire-and-forget; wrap it so a synchronous
      // throw or an async rejection surfaces on the log instead of vanishing,
      // and trace each notification by message_id.
      const messageId = meta.message_id ?? '(no message_id)'
      defaultLogInfo(`notifying the Claude session of message ${messageId}`)
      try {
        server
          .notification(channelNotification(content, meta))
          .then(() => defaultLogInfo(`notification delivered for message ${messageId}`))
          .catch((err) =>
            defaultLogError(`notification send failed for message ${messageId}`, err),
          )
      } catch (err) {
        defaultLogError(`notification send threw for message ${messageId}`, err)
      }
    },
  })

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: core.tools }))
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    core.handleTool(request.params.name, request.params.arguments ?? {}),
  )

  shutdown.register('feishu-transport', () => transport.close())
  shutdown.register('mcp-server', () => server.close())
  shutdown.watch(server)
  // Backstop for a parent that goes away without closing the MCP stdio
  // connection: a server orphaned to init keeps a Feishu connection slot.
  shutdown.watchParent()

  await server.connect(new StdioServerTransport())
  await transport.start(core.routes)
}

// Run `main` when invoked as the program entry, not when a test imports this
// module. `realpathSync` canonicalizes the invocation path so it matches the
// symlink-resolved module URL.
const invokedPath = process.argv[1]
if (invokedPath !== undefined && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[feishu-channel] failed to start:', err)
    process.exit(1)
  })
}
