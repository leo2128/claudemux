# feishu-channel

A [Claude Code](https://claude.com/claude-code) **channel** plugin for Feishu (飞书).
Receive Feishu messages in a running Claude Code session and reply back — all
over a long-lived WebSocket connection, so no public webhook URL is needed.

## Status

Early development. The channel server and Feishu SDK integration are still being
built; the core logic modules (access control, text chunking, content parsing)
and their tests land first.

## Prerequisites

- [Claude Code](https://claude.com/claude-code) v2.1.80 or later (channels are a
  research-preview feature).
- [Bun](https://bun.sh) — the channel server runtime.
- A Feishu **self-built app** with the Bot capability and the long-connection
  event-subscription mode enabled.

## How it works

The plugin ships an MCP server that declares the `claude/channel` capability.
It opens a WebSocket to the Feishu Open Platform (`lark.WSClient`), receives
`im.message.receive_v1` events, applies access control, and forwards approved
messages into the Claude Code session as `notifications/claude/channel`. Claude
replies through MCP tools the server exposes, which call the Feishu messaging
API.

## Development

```bash
cd plugins/feishu-channel
bun install
bun test        # run the unit suite
bun run typecheck
```

Core logic lives in `src/` as small, dependency-free modules so it can be unit
tested without a live Feishu connection or a running MCP server. Tests are in
`test/` and use `bun:test`; input-heavy functions are covered with
property-based tests via `fast-check`.

## License

MIT
