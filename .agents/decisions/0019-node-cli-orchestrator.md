# 0019 — The 1.0 line retires the MCP-native core for a pure Node `tm` CLI

- **Status:** Accepted
- **Date:** 2026-05-23
- **Affects:** the **`next`** line (version line `1.0.0-beta.0`) — [`bin/tm`](/plugins/claudemux/bin/tm), the [`core/`](/plugins/claudemux/core) TypeScript package, the runtime (Bun → Node), and the Codex teammate integration. **Supersedes [decision 0018](/.agents/decisions/0018-mcp-native-orchestration-core.md).**

## Context

[Decision 0018](/.agents/decisions/0018-mcp-native-orchestration-core.md) chose
a resident, **MCP-native orchestration core** to replace `tm`, with per-agent
teammate drivers. Its strangler migration was under way and had reached Phase
B: 11 of 17 `tm` verbs were reimplemented as native TypeScript inside the core
(then in `core/src/native.ts`; now split per-engine under
[`core/src/engines/claude/`](/plugins/claudemux/core/src/engines/claude)).

With the implementation in hand and the Codex integration being scoped, two
properties of the MCP-native shape became load-bearing — and a third, separate,
finding about Codex emerged.

- **Completion-perception — the primary reason.** 0018's own design (its §6)
  already conceded that a Claude Code dispatcher cannot reach the core's MCP
  server directly: the harness cannot hold a tool call open across an idle
  period, and an MCP push notification does not wake an idle session
  (`anthropics/claude-code#44380`). The only re-entry affordance is the Bash
  tool's `run_in_background`. So every dispatcher→core call was *already* routed
  through one `Bash(run_in_background)` invocation of a thin CLI shim. Once a
  CLI shim fronts every call, the resident MCP server behind it earns nothing —
  it is a process to keep alive, a unix socket, an MCP transport, and an
  in-memory registry, all of it overhead for a capability the shim already
  delivers. The MCP layer sits dead between the shim and the verb code.
- **The single resident process — the secondary reason.** A resident core is
  one long-lived process: a single point of failure, a thing to supervise, to
  restart, and to reconcile after a crash. 0018's whole registry
  crash-recovery design exists only to serve that resident process. A
  per-invocation CLI has no such failure mode and needs no such machinery.
- **Codex does not need a resident core.** Scoping the Codex driver showed a
  CLI can spawn and talk to a `codex app-server` exactly as well as a resident
  process can — see the Decision below. The resident core was never load-bearing
  for the Codex use case it was partly justified by.

## Decision

The `next` line **drops the MCP-native resident core.** 1.0 is a **pure Node
CLI**: `tm`, rewritten from the ~2,200-line Bash script into TypeScript run on
Node — still a per-invocation command-line tool, with no resident process, no
MCP server, and no socket.

- **`tm` stays a CLI; it stops being Bash.** The native-TypeScript verb
  implementations written for Phase B of 0018's migration (then in
  `core/src/native.ts`; later split per-engine — see
  [decision 0024](/.agents/decisions/0024-multi-engine-tui-architecture.md))
  are **kept** and become the body of the new CLI. What is dropped is the
  MCP wrapper around them — the resident server, the socket transport,
  and the in-memory teammate registry.
- **Runtime: Bun → Node.** The `core/` package runs on Bun today; the rewritten
  `tm` runs on Node, the broader-installed runtime for a tool shipped onto
  users' machines. The Bun → Node move that 0018's spec had parked on its
  backlog is pulled forward into the pivot.
- **Codex teammates connect to a self-spawned `app-server`.** Empirically:
  `codex app-server`'s `daemon` subcommand requires an OpenAI-hosted
  installation and is unusable here; its `proxy` subcommand is a raw byte
  tunnel, while the `app-server` listen socket itself speaks WebSocket frames —
  a raw tunnel cannot carry the protocol. So claudemux spawns
  `codex app-server --listen unix://<path>` itself, detached, and connects to
  it with a **WebSocket JSON-RPC client**.
- **Process supervision moves to claudemux.** A `codex app-server` is a
  long-lived process; with no resident core to hold it, the CLI owns its
  lifecycle — spawn, detach, record the pid, detect a crash, restart, reap.
  That state lives in a **filesystem-backed Codex-daemon process registry** (a
  protocol file set, distinct from 0018's in-memory `registry.ts`, which is
  removed). Each `tm` invocation that needs a Codex teammate reads that
  registry and reconciles the daemon before use.
- **The experimental protocol is pinned.** `codex app-server` is marked
  `[experimental]` end to end, and its JSON-RPC messages omit the `jsonrpc`
  version field — they are not strict JSON-RPC 2.0. The WebSocket client must
  pin the message schema explicitly and ship schema tests, so an upstream
  protocol change fails loudly at a known seam rather than corrupting a turn
  silently.

## Consequences

- **[Decision 0018](/.agents/decisions/0018-mcp-native-orchestration-core.md)
  is superseded.** Its resident-core architecture, the asymmetric dispatcher
  adapter, the MCP completion-mechanism analysis, and the M1–M5 metrics are no
  longer the plan. What 0018's migration *built* is not wasted: its Phase B
  native-verb code is this pivot's starting point.
- **`core/`'s MCP modules are removed** — `server.ts`, `socket-transport.ts`,
  `subscription.ts`, `registry.ts`, and the MCP tool surface in `core.ts` /
  `verbs.ts`. `native.ts` and the verb backends (`tmux.ts`, `column.ts`,
  `grep.ts`, `tm.ts`, `paths.ts`) are kept. This is stage 2 of the migration
  roadmap in the spec.
- **The dispatcher adapter collapses to nothing.** 0018 needed a per-dispatcher
  harness adapter — a Bash shim for Claude Code, direct MCP for Codex. With no
  MCP server the dispatcher just runs `tm`, the same model as the `main` 0.x
  line. 0018's *model-agnostic dispatcher* goal is dropped with the core: a
  Codex **dispatcher** was contingent on a Codex-side completion path the pivot
  does not build. Codex as a **teammate** — and as an ask-mode reviewer, the
  headline use case — is unaffected and survives intact.
- **Completion-awareness is the 0.x model, kept.** `tm`'s atomic verbs block on
  the `/tmp` idle signal; the dispatcher wraps a `tm` call in
  `Bash(run_in_background)`. That is exactly what 0.x does — and exactly what
  0018's design was forced back onto through its shim — so the pivot loses no
  completion capability. For a Codex teammate, completion is the `app-server`
  `turn/completed` event, read by the `tm` invocation blocking on the turn.
- **Process supervision is new work claudemux owns.** Under 0018 the resident
  core held the `app-server` connection and its liveness subscription. A CLI is
  stateless per invocation, so daemon supervision becomes an explicit,
  filesystem-mediated protocol — see the spec.
- **Enforcement.** The experimental-protocol hazard is guarded by the pinned
  schema and schema tests named in the Decision, not by prose. The
  behavior-preserving conformance harness from 0018's Phase B is kept — the verb
  migration stays pinned to `tm`'s current behavior, bug for bug.
- **Versioning:** this record and the spec are pure docs — no `version` bump
  ([decision 0014](/.agents/decisions/0014-changeset-release-versioning.md));
  the `1.0.0-beta.0` line is unchanged. The roadmap stages that follow are
  feature-class and carry their own changesets.

## References

- [decisions/0018-mcp-native-orchestration-core.md](/.agents/decisions/0018-mcp-native-orchestration-core.md) — the superseded decision; its Phase B native-verb work is carried forward.
- [domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md) — the architecture contract for the CLI orchestrator and the migration roadmap.
- [components/tm.md](/.agents/components/tm.md), [components/claudemux-core.md](/.agents/components/claudemux-core.md) — the components this reshapes.
- [components/hooks.md](/.agents/components/hooks.md), [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the Claude-side `/tmp` protocol, unchanged and carried forward.
- [decision 0014](/.agents/decisions/0014-changeset-release-versioning.md) — why this pure-docs change touches no `version` field.
