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
into every process it spawns, including this MCP server. So the open question
is not how to fix a connection bug — there is none in the channel's runtime —
but whether a long-lived WebSocket that only ever talks to a
directly-reachable Feishu should run *through* the session proxy at all. It
should not: the channel does not need the proxy, and routing a persistent
connection through it ties the channel's uptime to the health and lifecycle
of a proxy it has no use for. This record is therefore a **hardening** change
— decoupling the connection from the session proxy — not a bug fix.

## Decision

The MCP server is launched with the proxy environment cleared. `.mcp.json`
carries an `env` block that sets `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`,
and `https_proxy` to the empty string. An MCP server's `env` merges over the
inherited environment, and an empty-string value **overrides** a same-named
session variable rather than being skipped — so this clears the proxy for
this server only, while the rest of the Claude Code session keeps it. That
merge behavior is undocumented; it was verified empirically (see
Consequences).

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
  reachable *through* a proxy, the channel can no longer be used — and there
  is no opt-out: no setting or flag routes it back through the session proxy.
  This is a deliberate, documented scope reduction.
- The empty `env` values in `.mcp.json` are load-bearing. Removing the block
  because it "looks empty" reintroduces the session proxy into the server.
  `test/mcp-config.test.ts` asserts the four keys are present and empty, so
  the block cannot be dropped unnoticed — CI runs with no proxy and would
  otherwise stay green either way.
- The `env`-merge behavior was verified by launching Claude Code 2.1.146 with
  a proxy set in its environment and an MCP server whose `env` block clears
  it: the spawned process received the proxy variables as the empty string,
  not the inherited value. The behavior being undocumented, a future Claude
  Code version that changed empty-`env` merging to *skip* empty values would
  silently break this clearing — and `feishu-live` in CI would not catch it
  (CI has no proxy), only a proxied session would regress.
- Clearing the proxy must happen at launch (`.mcp.json`), not in code: Bun
  snapshots the proxy environment at process start.

## References

- `plugins/feishu-channel/.mcp.json` — the `env` block.
- `plugins/feishu-channel/test/mcp-config.test.ts` — guards the four cleared keys.
- `plugins/feishu-channel/src/feishu.ts`, `src/connection.ts` — the stock
  transport and the connection-lifecycle logging.
- [components/feishu-channel.md](/.agents/components/feishu-channel.md).
