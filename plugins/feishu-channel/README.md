# feishu-channel

A [Claude Code](https://claude.com/claude-code) **channel** plugin for Feishu
(飞书). Receive Feishu messages in a running Claude Code session and reply back —
all over a long-lived WebSocket connection, so no public webhook URL is needed.

## Prerequisites

- [Claude Code](https://claude.com/claude-code) **v2.1.80 or later** — channels
  are a research-preview feature and are not available in earlier versions.
- [Bun](https://bun.sh) — the channel server runtime. The plugin installs its
  own dependencies on first launch.
- A Feishu **self-built app** with the Bot capability (see below).

## Install

Add the claudemux marketplace, then install the plugin:

```
/plugin marketplace add excitedjs/claudemux
/plugin install feishu-channel@claudemux
```

## Configure your Feishu app

Create a self-built app on the [Feishu Open Platform](https://open.feishu.cn)
(open.larksuite.com for Lark):

1. Create a new **self-built app** (企业自建应用).
2. Enable the **Bot** capability (添加机器人能力).
3. Under **Event Subscription** (事件订阅), choose the **long-connection** mode.
   This plugin connects outbound over a WebSocket — you do not configure a
   request URL.
4. Subscribe to the **receive message** event, `im.message.receive_v1`.
5. Grant the permission scopes the bot needs: reading incoming messages,
   sending messages as the bot, and — for the `react` tool — adding message
   reactions. The app's permission console lists each scope.
6. **Publish a release** of the app so the bot and its permissions take effect.
7. From the app's credentials page, copy the **App ID** and **App Secret**.

Store the credentials in the channel's env file at
`~/.claude/channels/feishu/.env`:

```
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The channel server reads this file on startup. `FEISHU_APP_ID` /
`FEISHU_APP_SECRET` set in the process environment are used as a fallback. The
server refuses to start if neither source supplies both values.

## Enable the channel

A plugin from a third-party marketplace is not on Anthropic's official channel
allowlist, so launch Claude Code with the development-channels flag:

```
claude --dangerously-load-development-channels plugin:feishu-channel@claudemux
```

Listing the plugin in `.mcp.json` is not enough on its own — Claude Code only
registers a channel when it is named on the command line. The flag also does
not override an organization's `channelsEnabled` policy; if channels are
disabled org-wide, the channel will not load.

## How it works

The plugin ships an MCP server (over stdio) that declares the `claude/channel`
capability.

**Inbound.** The server opens a WebSocket to the Feishu Open Platform
(`lark.WSClient`) and receives `im.message.receive_v1` events. Each message is
parsed, run through access control, and — if approved — delivered into the
Claude Code session as a `notifications/claude/channel` notification. Claude
sees it as a `<channel source="feishu">` block whose attributes carry the
routing context: `chat_id`, `message_id`, `chat_type` (`p2p` or `group`), and
`sender_id`.

**Outbound.** The server exposes three MCP tools:

| Tool | Purpose |
|---|---|
| `reply` | Send a text message into a chat (`chat_id` + `text`). |
| `react` | Add an emoji reaction to a message (`message_id` + `emoji`). |
| `edit_message` | Replace the text of a message the channel sent (`message_id` + `text`). |

The terminal operator sees the inbound message and Claude's tool calls; the
reply text itself appears in Feishu, not in the terminal.

## Access control

Messages are gated before they reach Claude, so an open bot is not an open door
to the session:

- **Direct messages** from an unknown sender are not delivered. The channel
  replies with a one-time **pairing code**; an operator approves the sender out
  of band, after which their messages are delivered.
- **Group messages** are delivered only from configured groups, and by default
  only when the bot is @-mentioned.

The policy lives in `~/.claude/channels/feishu/access.json`. A corrupt or
missing file is reported and the channel falls back to safe defaults rather
than failing open.

## Development

```bash
cd plugins/feishu-channel
bun install
bun test          # run the unit suite
bun run typecheck
```

Core logic lives in `src/` as small, dependency-free modules so it can be unit
tested without a live Feishu connection or a running MCP server. Tests are in
`test/` and use `bun:test`; input-heavy functions are covered with
property-based tests via `fast-check`. The same suite runs in CI under the
`feishu-channel` job.

## License

MIT
