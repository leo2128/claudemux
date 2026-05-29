/**
 * Dog-food the markdown-reply path end-to-end through the channel core.
 *
 * The script drives `createChannelCore(...).handleTool(...)` — the same entry
 * point the MCP server hits when Claude calls `reply` or `edit_message` — so
 * what gets sent is the production code path, not a hand-written SDK call.
 * After each step it reads the message back via the Feishu API to confirm the
 * card structure and the patch were accepted.
 *
 * Not part of the test suite or CI: it talks to live Feishu and is meant to
 * be run manually after a change to the outbound payload.
 *
 * Usage:
 *   tsx test/dogfood-markdown.ts <chat_id>
 *
 *   chat_id — the conversation to post into; for a p2p chat with the operator,
 *   reuse the chat_id from any inbound `im.message.receive_v1` event the
 *   channel has logged.
 */

import * as lark from '@larksuiteoapi/node-sdk'

import { createFeishuTransport } from '../src/feishu'
import { envFile, stateDir } from '../src/paths'
import {
  createChannelCore,
  loadCredentials,
  type ChannelCore,
} from '../src/server'

const chatId: string | undefined = process.argv[2]
if (!chatId) {
  console.error('usage: tsx test/dogfood-markdown.ts <chat_id>')
  process.exit(2)
}
const targetChatId: string = chatId

const credentials = loadCredentials(envFile(stateDir()))

/**
 * The dog-food run holds the single-instance lock briefly (it does not start
 * the inbound WebSocket — only `transport.start()` would do that), but a
 * separate lock file keeps it out of the production server's way if one is
 * already running. The real channel state at `~/.claude/channels/feishu/` is
 * left untouched.
 */
const lockPath = '/tmp/feishu-channel-dogfood.lock'

const transport = createFeishuTransport(credentials, lockPath)
const core: ChannelCore = createChannelCore({
  transport,
  accessFile: '/tmp/feishu-channel-dogfood-access.json',
  notify: async () => {
    /* no inbound to forward in this script */
  },
})

/** Raw lark client for the readback step — independent from the transport. */
const readClient = new lark.Client({
  appId: credentials.appId,
  appSecret: credentials.appSecret,
})

interface MessageView {
  msg_type?: string
  updated?: boolean
  body?: { content?: string }
}

async function readBack(messageId: string): Promise<MessageView | null> {
  // The SDK does not surface `im.v1.messages.get` as a typed method, so use
  // the raw request channel — `client.request` still attaches the
  // tenant_access_token automatically.
  const res = await readClient.request<{ data?: { items?: MessageView[] } }>({
    method: 'GET',
    url: `/open-apis/im/v1/messages/${messageId}`,
  })
  return res.data?.items?.[0] ?? null
}

function describeToolResult(result: { content?: unknown; isError?: boolean }): string {
  const text = Array.isArray(result.content)
    ? result.content
        .map((c) => (c && typeof c === 'object' && 'text' in c ? (c as { text: string }).text : ''))
        .join('')
    : ''
  return `${result.isError ? 'ERROR' : 'ok'}: ${text}`
}

function extractMessageId(toolText: string): string | null {
  // The reply tool's success line is `Sent to <chat_id> as <message_id>.`.
  const match = /as\s+(om_[A-Za-z0-9]+)/.exec(toolText)
  return match?.[1] ?? null
}

const sendMarkdown = [
  '# Markdown reply dog-food',
  '',
  'Driven through `createChannelCore.handleTool("reply", ...)` — the same path the MCP server takes.',
  '',
  '- **bold** and *italic*',
  '- `inline code`',
  '- [a link](https://www.feishu.cn)',
  '',
  '```ts',
  "export function markdownCardContent(text: string): string {",
  "  return JSON.stringify({ /* card envelope */ })",
  '}',
  '```',
  '',
  '| feature       | supported |',
  '| ------------- | --------- |',
  '| bold / italic | yes       |',
  '| lists         | yes       |',
  '| fenced code   | yes       |',
].join('\n')

const editMarkdown = [
  '# Markdown reply dog-food (edited)',
  '',
  'Patched via `handleTool("edit_message", ...)`. Confirms the `im.message.patch`',
  'path through the channel core succeeds for a card the same flow just sent.',
  '',
  '1. send via reply tool',
  '2. edit via edit_message tool',
  '3. read the message back',
  '',
  'And a fenced block to show the edited body really replaced the original:',
  '',
  '```diff',
  '- old card body',
  '+ new card body',
  '```',
].join('\n')

async function main(): Promise<void> {
  const sent = await core.handleTool('reply', { chat_id: targetChatId, text: sendMarkdown })
  const sentText = describeToolResult(sent)
  console.log('reply →', sentText)
  if (sent.isError) process.exit(1)

  const messageId = extractMessageId(sentText)
  if (!messageId) {
    console.error('could not extract message_id from reply result')
    process.exit(1)
  }

  const afterSend = await readBack(messageId)
  console.log('readback after send →', JSON.stringify(afterSend))
  if (afterSend?.msg_type !== 'interactive') {
    console.error(`expected msg_type=interactive after reply, got ${afterSend?.msg_type ?? 'null'}`)
    process.exit(1)
  }

  const edited = await core.handleTool('edit_message', {
    message_id: messageId,
    text: editMarkdown,
  })
  const editedText = describeToolResult(edited)
  console.log('edit_message →', editedText)
  if (edited.isError) process.exit(1)

  const afterEdit = await readBack(messageId)
  console.log('readback after edit →', JSON.stringify(afterEdit))
  if (afterEdit?.updated !== true) {
    console.error('expected updated=true after edit_message')
    process.exit(1)
  }

  console.log(`dog-food OK — message_id=${messageId}`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => {
    void transport.close()
  })
