# 0008 — Feishu channel: launch the MCP server without the session HTTP proxy

- **Status:** Accepted
- **Date:** 2026-05-21
- **Affects:** `plugins/feishu-channel/` (`.mcp.json`, `src/feishu.ts`)

## Context

A separate diagnosis reported that the Feishu long connection fails whenever
an HTTP proxy (`HTTP_PROXY` / `HTTPS_PROXY`) is set: the Lark SDK's `axios`
sends an HTTPS request through the proxy without a `CONNECT` tunnel, so
cleartext reaches Feishu's TLS port and is rejected with `400`, and the
WebSocket is never reached.

That diagnosis ran under **Node** — the diagnosis host had no Bun. The
channel's MCP server runs under **Bun** (`.mcp.json` declares `command:
"bun"`). The two runtimes differ here:

- Under Node, `axios` reads `HTTP_PROXY` itself and mishandles the
  HTTPS-through-HTTP-proxy case — the reported bug.
- Under Bun, the runtime applies `HTTP_PROXY` at the networking layer, with a
  correct `CONNECT` tunnel. Verified: the stock SDK (`new lark.WSClient({
  appId, appSecret })`, no custom HTTP instance) connects through a proxy
  fine under Bun.

So the reported bug does not occur in the channel's actual runtime. Giving
the SDK a custom `axios` instance with `proxy: false` does **not** fix
anything under Bun either: `proxy: false` disables only `axios`'s own proxy
layer, while Bun still applies the proxy at the runtime layer — and Bun reads
the proxy environment once, at process start, so clearing it from inside
`server.ts` is too late.

Claude Code injects `HTTP_PROXY` / `HTTPS_PROXY` from `~/.claude/settings.json`
into every process it spawns, including this MCP server. The channel only
ever talks to Feishu, and Feishu is reachable directly — it does not need the
session's proxy, and routing through it adds a dependency on the proxy's
health.

## Decision

The MCP server is launched with the proxy environment cleared. `.mcp.json`
carries an `env` block that sets `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`,
and `https_proxy` to the empty string. An MCP server's `env` merges over the
inherited environment and overrides a same-named session variable, so this
clears the proxy for this server only — the rest of the Claude Code session
keeps it.

The SDK is used stock — no custom `httpInstance`. The stock client connects
directly once the proxy environment is gone; a custom HTTP instance would
only add the need to re-implement the SDK's own response interceptor.

The connection lifecycle is made observable instead: `src/feishu.ts` wires
the `WSClient`'s `onError` / `onReconnecting` / `onReconnected` callbacks and
a startup-grace watchdog (`src/connection.ts` holds the pure log-line
builders), so a failed or dropped connection is logged rather than retrying
silently.

## Consequences

- The channel connects to Feishu directly; a session proxy that is down or
  misconfigured cannot break it.
- The MCP server needs a direct network path to Feishu (`open.feishu.cn` and
  the `*.feishu.cn` WebSocket endpoint). On a network where Feishu is only
  reachable *through* a proxy, the channel is not configurable for that — a
  deliberate, documented scope limit.
- The empty `env` values in `.mcp.json` are load-bearing. Removing the block
  because it "looks empty" reintroduces the session proxy into the server.
- Clearing the proxy must happen at launch (`.mcp.json`), not in code: Bun
  snapshots the proxy environment at process start.

## References

- `plugins/feishu-channel/.mcp.json` — the `env` block.
- `plugins/feishu-channel/src/feishu.ts`, `src/connection.ts` — the stock
  transport and the connection-lifecycle logging.
- [components/feishu-channel.md](/.agents/components/feishu-channel.md).
