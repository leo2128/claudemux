# Component: the `feishu-channel` plugin (WIP)

> **Status: in progress.** This plugin is being built on branch
> `feishu-channel-plugin` and is **not yet merged to `main`**. Until it
> merges, `plugins/feishu-channel/` does not exist on `main`. This doc
> records the design and intent; verify against the live plugin once the
> branch lands. Rationale is in
> [decision 0005](/.agents/decisions/0005-feishu-channel-plugin.md).

`feishu-channel` is a second plugin shipped from this repo: a Claude Code
**channel** for Feishu (飞书). It bridges Feishu chat messages into a running
Claude Code session and replies back, over a long-lived WebSocket — so no
public webhook URL is needed.

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
2. Receives `im.message.receive_v1` events.
3. Applies access control.
4. Forwards approved messages into the Claude Code session as
   `notifications/claude/channel`.

Claude replies through MCP tools the server exposes, which call the Feishu
messaging API. Channels are a Claude Code research-preview feature
(requires Claude Code ≥ 2.1.80).

## Layout (on the `feishu-channel-plugin` branch)

| Path | Holds |
|---|---|
| `.claude-plugin/plugin.json` | Plugin manifest (`name: feishu-channel`) |
| `.mcp.json` | MCP server declaration — runs `bun run start` |
| `package.json` | Bun project; deps `@larksuiteoapi/node-sdk`, `@modelcontextprotocol/sdk` |
| `src/*.ts` | Core logic as small, dependency-free modules |
| `test/*.ts` | `bun:test` unit tests; input-heavy modules use property-based tests via `fast-check` |

The core logic (`access`, chunking, content parsing, pairing codes,
filename sanitization, …) is written as small modules with **no live-Feishu
dependency** so they unit-test without a running server or connection. The
server and SDK integration land after the core modules.

## Foot-guns

- **Bun is required** and is not a claudemux dependency. On the dev machine
  Bun lives at `~/.bun/bin`.
- **The CI workflow does not cover this plugin's tests yet.** `ci.yml` runs
  shellcheck + bats for claudemux only. Run `bun test` in
  `plugins/feishu-channel/` manually until CI is extended.
- It has its **own** `version` in its own `plugin.json`; the claudemux
  version-bump rule does not apply to it.

## See also

- [decisions/0005-feishu-channel-plugin.md](/.agents/decisions/0005-feishu-channel-plugin.md) — why a second plugin, why TS+Bun.
- [root.md](/.agents/root.md) — repo layout.
