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

import { readFileSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

import { chunk } from './chunk'
import { EventRegistry } from './events'
import type { ChannelDelivery, HandlerContext } from './events'
import type { FeishuCredentials, FeishuTransport, InboundRoutes } from './feishu'
import { createFeishuTransport } from './feishu'
import { createDocCommentHandler } from './handlers/doc-comment'
import { createImMessageHandler } from './handlers/im-message'
import { generatePairingCode } from './pairing'
import { accessFile, envFile, stateDir } from './paths'
import { ShutdownCoordinator } from './shutdown'

/** Version advertised to Claude Code in the MCP `initialize` handshake. */
const SERVER_VERSION = '0.1.0'

/** The JSON-RPC method that carries an inbound event to the Claude session. */
const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel'

/**
 * Characters per outbound text message. A conservative bound that stays well
 * under Feishu's text-message size limit; a longer reply is split into parts
 * so Feishu does not reject the whole send.
 */
export const FEISHU_TEXT_LIMIT = 4000

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
  /** Delivers a gated inbound event to the Claude session. */
  notify: ChannelNotifier
  /** Injected clock (epoch millis); defaults to `Date.now`. */
  now?: () => number
  /** Injected pairing-code generator; defaults to `generatePairingCode`. */
  generateCode?: () => string
  /** Reports a recoverable error; defaults to logging to stderr. */
  logError?: (message: string, err?: unknown) => void
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
      'Send a text message into a Feishu chat. Pass the chat_id from the <channel> tag of the message you are answering.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: {
          type: 'string',
          description: 'Target chat_id, copied verbatim from the inbound <channel> tag.',
        },
        text: { type: 'string', description: 'Message text to send.' },
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
    description: 'Replace the text of a message this channel previously sent.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'message_id of the bot message to edit.',
        },
        text: { type: 'string', description: 'New message text.' },
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

  const ctx: HandlerContext = {
    transport: deps.transport,
    accessFile: deps.accessFile,
    now,
    generateCode,
    logError,
  }

  // Every Feishu event type the channel reacts to is a registered handler.
  // A new event type is added by registering one more handler here.
  const registry = new EventRegistry()
    .register(createImMessageHandler())
    .register(createDocCommentHandler())

  const routes: InboundRoutes = {}
  for (const eventType of registry.eventTypes()) {
    routes[eventType] = (raw: unknown) => handleEvent(eventType, raw)
  }

  async function handleEvent(eventType: string, raw: unknown): Promise<void> {
    const handler = registry.get(eventType)
    if (!handler) return

    let delivery: ChannelDelivery | null
    try {
      delivery = await handler.handle(raw, ctx)
    } catch (err) {
      logError(`failed to handle a ${eventType} event`, err)
      return
    }
    if (!delivery) return

    try {
      await deps.notify(delivery.content, delivery.meta)
    } catch (err) {
      logError(`failed to deliver a ${eventType} notification`, err)
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
          // Feishu rejects an over-long text message, so a long reply is
          // split into parts that each fit, broken on a natural boundary.
          const parts = chunk(text, FEISHU_TEXT_LIMIT, 'newline')
          const ids: string[] = []
          for (const part of parts) {
            const result = await deps.transport.sendText(chatId, part)
            if (result.messageId) ids.push(result.messageId)
          }
          const summary =
            parts.length === 1
              ? `Sent to ${chatId}${ids[0] ? ` as ${ids[0]}` : ''}.`
              : `Sent to ${chatId} in ${parts.length} messages.`
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

function defaultLogError(message: string, err?: unknown): void {
  if (err === undefined) {
    console.error(`[feishu-channel] ${message}`)
  } else {
    console.error(`[feishu-channel] ${message}`, err)
  }
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
  'Use `react` to acknowledge a message with an emoji, and `edit_message` to revise a message',
  'you previously sent.',
  '',
  'kind="doc_comment" — a comment on a Feishu document. Attributes:',
  '- file_token, file_type: the document the comment is on.',
  '- comment_id, and reply_id when the event is a reply within a thread.',
  '- notice_type: "add_comment" or "add_reply".',
  'A doc comment has no chat to answer into — treat it as a signal to act on, not a',
  'message to reply to with `reply`.',
  '',
  'Only act on events that arrived through this channel.',
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
function loadCredentials(file: string): FeishuCredentials {
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
function readEnvFile(file: string): Record<string, string> {
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
  const transport = createFeishuTransport(credentials)
  const server = createMcpServer()

  const core = createChannelCore({
    transport,
    accessFile: accessFile(base),
    notify: (content, meta) => {
      void server.notification({
        method: CHANNEL_NOTIFICATION_METHOD,
        params: { content, meta },
      })
    },
  })

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: core.tools }))
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    core.handleTool(request.params.name, request.params.arguments ?? {}),
  )

  shutdown.register('feishu-transport', () => transport.close())
  shutdown.register('mcp-server', () => server.close())
  shutdown.watch(server)

  await server.connect(new StdioServerTransport())
  await transport.start(core.routes)
}

if (import.meta.main) {
  main().catch((err) => {
    console.error('[feishu-channel] failed to start:', err)
    process.exit(1)
  })
}
