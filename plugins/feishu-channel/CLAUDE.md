# feishu-channel plugin — dev entry

A Claude Code **channel** for Feishu (飞书): bridges Feishu events into a running Claude Code session and replies back over a long-lived WebSocket — no public webhook. TypeScript on Node, run through `tsx`, tested with `vitest`. Independent of the claudemux plugin (installs separately; shares only the repo and `.claude-plugin/marketplace.json`).

Depth lives in the KB (repo-root `.agents/`, not shipped to users): `.agents/components/feishu-channel.md` and the `feishu-channel-*` records under `.agents/decisions/`. This file is the entry index — where to start, what's easy to get wrong.

## Module map (concept → file)

- MCP server boot: `.mcp.json` runs `npm run start` → `npm install --silent && tsx src/server.ts`.
- Channel core: `src/server.ts` — `createChannelCore` does registry dispatch and exposes the outbound tools (`reply`, `react`, `edit_message`).
- Event registry (the extension seam): `src/events.ts` — the `EventHandler` interface and `EventRegistry`.
- Handlers, one per `event_type`: `src/handlers/im-message.ts` (`im.message.receive_v1`), `src/handlers/doc-comment.ts` (`drive.notice.comment_add_v1`).
- Transport (event-type agnostic): `src/feishu.ts` — `lark.WSClient`, `onError` / `onReconnecting` / `onReconnected`; log-line builders in `src/connection.ts`.
- Access control / pairing / content parsing: `src/*.ts`.
- Config factory: `scripts/configure.ts` (writes `.env`, verifies against Feishu); slash command `commands/configure.md`.
- Skill: `skills/access/`.

## Adding a Feishu event type

One handler module under `src/handlers/` plus one `register(...)` line in `createChannelCore`. The core pipeline and the transport do not change. Background: `.agents/decisions/feishu-channel-event-registry.md`.

## Traps (won't infer these from the code)

- **Doc-comment text: fetch with `fileComment.batchQuery`, not `fileComment.get`.** `get` serves only whole-document comments and 404s on selection-anchored ones (most of them). An empty comment body → check the endpoint before the bot's scopes. → `.agents/decisions/feishu-doc-comment-fetch-via-batch-query.md`.
- **`.mcp.json` clears `HTTP_PROXY` / `HTTPS_PROXY` (upper and lower case).** The channel talks to Feishu directly, not through the session proxy; the empty `env` values are load-bearing — `test/mcp-config.test.ts` fails if they are dropped. → `.agents/decisions/feishu-channel-launch-without-session-proxy.md`.
- **Replies route by `chat_id`, never `message_id`.** A `message_id` echoed back from some other context cannot redirect a reply into an unrelated chat.
- **Group access is the `access.json` `groupPolicy` switch:** `block` / `allowlist` (each group authorized by pairing) / `follow-user`. → `.agents/decisions/feishu-channel-group-policy-modes.md`.
- **An inbound chat message gets a "received" reaction on arrival, cleared on reply.** The emoji is a random pick from `RECEIVED_REACTION_EMOJIS` (👀 `GLANCE`, `LGTM`, `Typing`, `GoGoGo`, `OnIt`) via `pickReceivedReactionEmoji`. The `message_id → reaction_id` map lives in memory in `createChannelCore`, not on disk; removal keys off the returned `reaction_id`, so it is emoji-agnostic.

## Requirements / boundaries

- Node ≥ 22; the plugin installs its own deps on first channel launch (the `start` script), and is not a claudemux dependency.
- Channels are a Claude Code research-preview feature (Claude Code ≥ 2.1.80).
- Release intent: a Changesets fragment under package name `claude-channel-feishu` (release surface `src/**`). The plugin keeps its own `version` in `.claude-plugin/plugin.json`.

## Update this file when

A new event type or handler lands; the registry / transport seam changes; the proxy-clearing or `groupPolicy` shape changes; or a new top-level trap appears. A routine tweak inside one file needs no update. Follow the Knowledge Delta Protocol in `.agents/CONTRIBUTING.md`.
