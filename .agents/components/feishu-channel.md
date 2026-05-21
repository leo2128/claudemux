# Component: the `feishu-channel` plugin (WIP)

> **Status: in progress.** This plugin is being built on branch
> `feishu-channel-plugin` and is **not yet merged to `main`**. Until it
> merges, `plugins/feishu-channel/` does not exist on `main`. This doc
> records the design as built on the branch; re-verify it against the live
> plugin once the branch lands. Rationale is in
> [decision 0005](/.agents/decisions/0005-feishu-channel-plugin.md) and
> [decision 0006](/.agents/decisions/0006-feishu-channel-event-registry.md).

`feishu-channel` is a second plugin shipped from this repo: a Claude Code
**channel** for Feishu (飞书). It bridges Feishu events into a running Claude
Code session and replies back, over a long-lived WebSocket — so no public
webhook URL is needed.

## Why it lives here

claudemux orchestrates Claude Code sessions; a *channel* lets a user **reach**
a session from outside the terminal. The two are complementary, so the
Feishu channel ships from the same repo and the same
[`marketplace.json`](/.claude-plugin/marketplace.json) — but as a **separate
plugin**, not as part of the claudemux plugin. They install independently.

## Stack — and why it differs from claudemux

claudemux is Bash. `feishu-channel` is **TypeScript on Bun**. The job is a
long-lived WebSocket server plus an MCP server — a persistent networked
process, not a CLI — which is poorly served by Bash. Bun is the channel
server runtime.

## How a channel works

The plugin ships an MCP server (declared in
`plugins/feishu-channel/.mcp.json`) that advertises the `claude/channel`
capability. The server:

1. Opens a WebSocket to the Feishu Open Platform (`lark.WSClient`).
2. Receives the events the bot is subscribed to and routes each, by
   `event_type`, to a registered **event handler**.
3. The handler decodes the payload and — for chat messages — applies access
   control.
4. An approved event is forwarded into the Claude Code session as a
   `notifications/claude/channel` notification, rendered as a
   `<channel source="feishu">` block.

Claude replies through MCP tools the server exposes (`reply`, `react`,
`edit_message`), which call the Feishu API. Channels are a Claude Code
research-preview feature (requires Claude Code ≥ 2.1.80).

## The event registry — the extensibility seam

Event handling is a registry, not a per-event branch in the server. Each
Feishu event type is one `EventHandler` (`src/events.ts`) that declares its
`event_type` and maps a raw payload to a channel delivery. Adding a new event
type is **one handler module under `src/handlers/` plus one registration
line** in `createChannelCore` — the core pipeline and the transport do not
change. Two handlers exist on the branch:

- `im.message.receive_v1` — inbound chat messages (`src/handlers/im-message.ts`).
- `drive.notice.comment_add_v1` — document comments and replies
  (`src/handlers/doc-comment.ts`).

See [decision 0006](/.agents/decisions/0006-feishu-channel-event-registry.md)
for the rationale.

## Layout (on the `feishu-channel-plugin` branch)

| Path | Holds |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (`name: feishu-channel`, own `version`) |
| `.mcp.json` | MCP server declaration — runs `bun run start` |
| `package.json` | Bun project; deps `@larksuiteoapi/node-sdk`, `@modelcontextprotocol/sdk` |
| `src/events.ts` | The `EventHandler` interface and the `EventRegistry` |
| `src/server.ts` | `createChannelCore` — registry dispatch + the outbound tools |
| `src/feishu.ts` | The Feishu transport boundary (event-type agnostic) |
| `src/connection.ts` | Pure log-line builders for the WebSocket connection lifecycle |
| `src/handlers/*.ts` | One module per Feishu event type |
| `src/*.ts` | Core logic — access control, content parsing, pairing, … |
| `scripts/configure.ts` | Credential factory — writes `.env`, verifies against Feishu |
| `commands/configure.md` | The `/feishu-channel:configure` slash command |
| `test/*.test.ts` | `bun:test` unit tests; input-heavy modules use `fast-check` |
| `test/feishu-live.ts` | Live integration test against the real Feishu platform |
| `skills/` | The `access` skill |

The core logic is written as small modules with **no live-Feishu dependency**
so it unit-tests without a running server or connection.

## Foot-guns

- **Bun is required** and is not a claudemux dependency. On the dev machine
  Bun lives at `~/.bun/bin` and is not on `PATH` — invoke it by absolute path.
- The plugin has its **own** `version` in its own `plugin.json`; the
  claudemux version-bump rule and its pre-commit hook do not apply to it.
- `drive.notice.comment_add_v1` and its payload shape are corroborated by
  third-party integrations, **not** confirmed against Feishu's own docs. The
  handler decodes defensively and never throws; still, confirm the event in
  the Feishu app console before relying on it.
- The channel connects to Feishu **directly**, not through the session's HTTP
  proxy. `.mcp.json` clears `HTTP_PROXY` / `HTTPS_PROXY` (upper and lower case)
  in the MCP server's environment, so a proxy set for the Claude Code session
  does not apply to this server. The empty `env` values in `.mcp.json` are
  load-bearing — `test/mcp-config.test.ts` fails if they are dropped. See
  [decision 0008](/.agents/decisions/0008-feishu-channel-launch-without-session-proxy.md).
- `src/feishu.ts` wires the `WSClient`'s `onError` / `onReconnecting` /
  `onReconnected` callbacks and a startup-grace watchdog, so a failed or
  dropped connection is logged instead of retrying silently. The log wording
  is built by the pure functions in `src/connection.ts`.

## See also

- [decisions/0005-feishu-channel-plugin.md](/.agents/decisions/0005-feishu-channel-plugin.md) — why a second plugin, why TS+Bun.
- [decisions/0006-feishu-channel-event-registry.md](/.agents/decisions/0006-feishu-channel-event-registry.md) — the event registry and core design choices.
- [components/repo-tooling.md](/.agents/components/repo-tooling.md) — the CI `feishu-channel` job.
- [root.md](/.agents/root.md) — repo layout.
