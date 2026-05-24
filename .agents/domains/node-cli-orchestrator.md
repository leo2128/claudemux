# Domain: the Node CLI orchestrator (the `next` line)

> **Status:** architecture spec for the `next` 1.0 line. **Target:** the
> `next` branch, version line **`1.0.0`** (developed in parallel with
> `main`'s 0.x). **Decision record:**
> [0019](/.agents/decisions/0019-node-cli-orchestrator.md), which supersedes the
> MCP-native design of [0018](/.agents/decisions/0018-mcp-native-orchestration-core.md).
>
> Read [0019](/.agents/decisions/0019-node-cli-orchestrator.md) first for *why*
> the resident MCP-native core was dropped; this document is the contract for
> *what replaces it*.
>
> **Versioning:** installed plugin metadata comes from
> [`plugins/claudemux/.claude-plugin/plugin.json`](/plugins/claudemux/.claude-plugin/plugin.json);
> core package metadata comes from
> [`plugins/claudemux/core/package.json`](/plugins/claudemux/core/package.json).
> Feature-class changes still carry changeset fragments as described in
> [decision 0014](/.agents/decisions/0014-changeset-release-versioning.md).

---

## 1. What this is, and what it replaces

claudemux's orchestrator is **`tm`** — the CLI the dispatcher runs to spawn,
message, wait on, inspect, and kill teammates. On the `main` 0.x line `tm` is a
~2,200-line Bash script ([components/tm.md](/.agents/components/tm.md)).

On the `next` 1.0 line `tm` is **rewritten in TypeScript and run on Node** —
still a command-line tool, not a resident process and not an MCP server.

[Decision 0019](/.agents/decisions/0019-node-cli-orchestrator.md) retired the
resident MCP-native core that [decision 0018](/.agents/decisions/0018-mcp-native-orchestration-core.md)
had planned; 0019 carries the rationale. 1.0's orchestrator is a CLI: the
dispatcher runs `tm` and reads its result, with no resident process between
them.

What 1.0 adds over 0.x is the Node rewrite (native-TypeScript verbs and a real
test surface) and **Codex as a teammate** (§5). The Claude-teammate mechanism
(§4) is carried forward unchanged.

---

## 2. The CLI model — stateless per invocation

`tm` is invoked once per command and exits. It holds no state between
invocations and runs no background process of its own.

Every verb is a short-lived process: parse arguments → read the world → act →
print a `{stdout, stderr}` pair and an exit code → exit. This is the 0.x
contract — the atomic round-trip verbs and the deliberate stdout/stderr split
of [decision 0002](/.agents/decisions/0002-atomic-tm-verbs.md) — carried
forward verbatim.

The consequence shapes everything below: all cross-invocation state lives
**outside** `tm`, in the stores of §3. `tm` is the code that reads and mutates
those stores; it is never their owner and never their cache.

---

## 3. Where the state lives

| Store | Holds | Owner |
|---|---|---|
| **tmux sessions** | each Claude teammate's live `claude` REPL — one session per repo | tmux |
| **the `/tmp` file protocol** | the BUSY/idle turn signal, sid files, the cwd / ready / send-at markers | the hooks and `tm` jointly — see [cross-process-protocol](/.agents/domains/cross-process-protocol.md) |
| **`~/.claude/projects/<encoded>/`** | each teammate's transcripts and auto-memory | Claude Code |
| **the Codex `app-server` daemon** | each Codex teammate's persisted thread(s) | a `codex app-server` process claudemux spawns (§5) |
| **the Codex-daemon process registry** | each spawned `app-server`'s socket path, pid, and last-seen liveness | `tm` (§5) |

A `tm` invocation reconstructs everything it needs from these stores on every
call. There is no in-memory teammate registry — 0018's `registry.ts` is removed
(§8); the live teammate set is enumerated from tmux for Claude teammates and
from the daemon process registry for Codex teammates.

---

## 4. The Claude teammate driver — tmux + hooks

A Claude teammate is a `claude` REPL in its own tmux session, working directory
set to the repo. `tm` drives it with `tmux new-session`, `tmux send-keys` (the
dual-send protocol), and the [`hooks/`](/plugins/claudemux/hooks/hooks.json)
bundle that maintains the `/tmp` BUSY/idle signal.

This is the 0.x mechanism, unchanged. It is described by
[components/hooks.md](/.agents/components/hooks.md),
[domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md),
and [decision 0001](/.agents/decisions/0001-hook-driven-busy-idle-signal.md);
1.0 carries it forward verbatim. The hook scripts stay in Bash — Claude Code
runs them — and the path-builder and cross-platform discipline of
[decision 0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md)
still binds every `/tmp` path the rewritten `tm` and the hooks share.

The turn-completion signal this driver produces is the same lossy-but-adequate
signal 0.x ships ([`on-stop.sh`](/plugins/claudemux/hooks/on-stop.sh)'s
documented empty-`.last` race); fixing that race is a separate tracked item,
not folded into the rewrite.

---

## 5. The Codex teammate driver — `codex app-server`

Codex ships a first-class bidirectional JSON-RPC protocol, `codex app-server`
(`turn/start`, `turn/interrupt`, `turn/steer`, `turn/completed`, thread
persistence). A Codex teammate uses it directly — no tmux, no screen-scraping.

- **Transport.** claudemux spawns `codex app-server --listen unix://<path>`
  itself, **detached**, and connects with a **WebSocket JSON-RPC client**. The
  `daemon` and `proxy` subcommands were evaluated and rejected
  ([0019](/.agents/decisions/0019-node-cli-orchestrator.md)): `daemon` requires
  an OpenAI-hosted installation; `proxy` is a raw byte tunnel and cannot carry
  the `app-server` listen socket, which itself speaks WebSocket frames.
- **`approval_policy: Never`.** A claudemux teammate runs unattended; the
  non-interactive posture is a requirement of being a teammate — the same
  reasoning as [decision 0007](/.agents/decisions/0007-teammates-launch-without-askuserquestion.md),
  generalized from Claude to Codex.
- **Process supervision.** The `app-server` is long-lived and outlives any
  single `tm` invocation — the daemon's thread state *is* the Codex teammate.
  With no resident process to hold it, `tm` owns the daemon lifecycle through
  the **Codex-daemon process registry** (§3): a filesystem file set recording
  each daemon's socket path, pid, and last-seen liveness. Each `tm` invocation
  that targets a Codex teammate reads the registry, checks the daemon is alive,
  spawns or restarts it if not, connects, runs its verb, and exits. The daemon
  persists; the `tm` process is ephemeral.
- **Schema pinning.** `codex app-server` is marked `[experimental]` end to end,
  and its JSON-RPC messages omit the `jsonrpc` version field — they are not
  strict JSON-RPC 2.0. The WebSocket client pins the message schema explicitly
  and ships schema tests, so an upstream protocol change fails loudly at a
  known seam rather than corrupting a turn silently.

---

## 6. Two interaction modes — teammate and ask

Codex is hosted in two modes — two distinct call contracts that share the §5
driver:

- **Teammate mode** — a hosted, long-running teammate, dispatched and waited on
  like a Claude teammate.
- **Ask mode** — Codex as a **cross-model reviewer / advisor**: a blocking call
  that returns a structured result inline, for a `/simplify` reviewer or a
  second opinion during plan negotiation. This is the headline use case the
  Codex integration is tuned for.

Ask mode wants structured output (`app-server`'s `output_schema`), model and
effort selection, and a fast cold start — keep an `app-server` warm rather than
paying a REPL boot per ask. The detailed two-mode design lands with the Codex
driver (roadmap stage 4); it is recorded here so the driver is built for both
modes from the start.

---

## 7. Completion-awareness

"The teammate's turn finished" reaches the dispatcher the same way on 1.0 as on
0.x: a `tm` atomic verb (`spawn` / `send` / `wait` / …) blocks until the turn
signal fires, then prints the teammate's reply. The dispatcher issues that `tm`
call inside `Bash(run_in_background)` so its own agent loop is not frozen, and
the harness's task-notification wakes it when `tm` exits.

- For a **Claude teammate** the turn signal is the `/tmp` idle marker the hooks
  write (§4).
- For a **Codex teammate** it is the `app-server` `turn/completed` event,
  observed by the blocking `tm` process over its WebSocket connection to the
  daemon.

[Decision 0019](/.agents/decisions/0019-node-cli-orchestrator.md) records why
this is the model rather than an MCP push notification.

---

## 8. Migration roadmap

The rewrite landed in stages, each its own PR. Behavior was preserved against
`tm` 0.x by the conformance harness — each native verb was pinned to `tm`'s
current behavior, bug for bug. Stage 3c retired the bash oracle and switched
the harness to committed golden JSON files (see
[components/claudemux-core.md](/.agents/components/claudemux-core.md)).

| Stage | Work | Status |
|---|---|---|
| **1 — pivot** | Record [decision 0019](/.agents/decisions/0019-node-cli-orchestrator.md); rewrite this spec. | landed |
| **2 — structure cleanup** | Stand up the Node CLI front end; remove the MCP modules and tool surface; complete the Bun → Node runtime move. | landed |
| **3 — hot-path verbs + bash retirement** | Migrate `spawn`/`send`/`wait`/`compact`/`resume`/`doctor` into native code under the live-teammate net (3a, 3b), then retire the Bash [`bin/tm`](/plugins/claudemux/bin/tm) (3c). | landed |
| **4 — Codex driver** | Add the Codex driver — the self-spawned `app-server`, the WebSocket JSON-RPC client, the daemon process registry, both interaction modes (§6), and the `tm doctor` orphan reap. See [decision 0022](/.agents/decisions/0022-codex-driver.md). | landed |

Stage 3 landed in three sub-stages:

- **3a:** the live-teammate integration harness — see
  [decision 0020](/.agents/decisions/0020-live-teammate-integration-harness.md).
  The harness drives a real teammate through `tm` so the verb migration in
  3b proceeded under a working regression net rather than ahead of one.
- **3b:** the six hot-path verbs became native TypeScript and the Node CLI
  gained a dev launcher at
  [`core/bin/tm`](/plugins/claudemux/core/bin/tm) so the live suite could be
  re-aimed at native via `CLAUDEMUX_TM`. The Bash `bin/tm` was unchanged.
- **3c:** the Bash `bin/tm` was retired. The PATH entry is now a small bash
  launcher that `exec`s `node` against the committed esbuild bundle at
  [`core/dist/cli.mjs`](/plugins/claudemux/core/dist/cli.mjs); the
  conformance harness's bash oracle is replaced by per-scenario golden
  JSON files under [`core/test/goldens/`](/plugins/claudemux/core/test/goldens),
  regenerated with `UPDATE_GOLDENS=1`.

After stage 4 lands, this roadmap section is pruned in the same change.

---

## See also

- [decisions/0019-node-cli-orchestrator.md](/.agents/decisions/0019-node-cli-orchestrator.md) — the decision and the *why*.
- [decisions/0018-mcp-native-orchestration-core.md](/.agents/decisions/0018-mcp-native-orchestration-core.md) — the superseded MCP-native design.
- [components/tm.md](/.agents/components/tm.md) — the `tm` CLI.
- [components/claudemux-core.md](/.agents/components/claudemux-core.md) — the `core/` TypeScript package and its current modules.
- [components/hooks.md](/.agents/components/hooks.md), [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the Claude driver's `/tmp` protocol.
- [decision 0002](/.agents/decisions/0002-atomic-tm-verbs.md), [0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md), [0007](/.agents/decisions/0007-teammates-launch-without-askuserquestion.md) — the 0.x design carried forward into 1.0.
