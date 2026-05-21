# 0005 — Feishu channel as a separate TypeScript+Bun plugin

- **Status:** Accepted
- **Date:** 2026-05
- **Affects:** repo layout, `marketplace.json`, the new `plugins/feishu-channel/`

## Context

claudemux orchestrates Claude Code *sessions*. It does not give a user a way
to **reach** a session from outside a terminal. Claude Code's
research-preview *channel* feature fills exactly that gap: a channel bridges
an external chat application into a running Claude Code session.

Feishu (飞书) is the target chat application. Feishu's Open Platform supports
a long-connection event-subscription mode, so a channel can receive messages
over an outbound WebSocket — no public webhook URL, no inbound firewall hole.

This raised three design questions: where the code lives, what it is written
in, and how it is tested before a live Feishu connection exists.

## Decision

Build the Feishu channel as a **separate plugin in the same repository**.

- **Separate plugin, same repo.** It ships from claudemux's repo and its
  `marketplace.json`, but as its own plugin with its own `plugin.json` and
  its own `version`. Orchestrator and channel are complementary but
  independent — a user installs either without the other. The claudemux
  version-bump rule does not apply to it.
- **TypeScript on Bun, not Bash.** claudemux is Bash because it is a CLI and
  a set of hook scripts. The channel is a long-lived WebSocket server plus
  an MCP server — a persistent networked process. That is poorly served by
  Bash; TypeScript on the Bun runtime fits it. The plugin's MCP server
  declares the `claude/channel` capability, opens a `lark.WSClient`
  WebSocket, and forwards `im.message.receive_v1` events into the session.
- **Dependency-free core modules, tested first.** The core logic — access
  control, text chunking, content parsing, pairing-code generation,
  filename sanitization — is written as small modules with no live-Feishu
  dependency, so each is unit-testable with `bun:test` (input-heavy modules
  use property-based tests via `fast-check`) before the server and SDK
  integration land. The core modules and their tests are committed first;
  the channel server comes after.

## Consequences

- The repo now hosts two plugins and a second language/runtime. Bun is
  required for `feishu-channel` development and is not a claudemux
  dependency.
- CI (`ci.yml`) runs the `feishu-channel` `bun test` suite and type-check in
  a dedicated `feishu-channel` job, separate from the claudemux shellcheck +
  bats job.
- `plugins/feishu-channel/` is the repo's second plugin on `main`, with its
  own `version` and CI job;
  [components/feishu-channel.md](/.agents/components/feishu-channel.md)
  documents the merged plugin.

## References

- Merged to `main` from the `feishu-channel-plugin` branch (PR #10).
- [components/feishu-channel.md](/.agents/components/feishu-channel.md).
