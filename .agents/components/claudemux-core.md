# Component: the orchestration core (the `next` line)

The orchestration core is the resident process that replaces [`bin/tm`](/plugins/claudemux/bin/tm)
on the **`next`** branch — the `1.0.0-beta.0` line developed in parallel with
`main`'s 0.x. It lives at [`/plugins/claudemux/core/`](/plugins/claudemux/core),
a Bun/TypeScript project alongside the Bash plugin.

The architecture, the rationale, and the strangler-migration plan are the
domain spec, [domains/mcp-native-orchestrator.md](/.agents/domains/mcp-native-orchestrator.md),
and decision [0018](/.agents/decisions/0018-mcp-native-orchestration-core.md).
This document is the **component** view: what the core's modules are and what
contracts they hold.

> **Status — Phase A of the strangler migration.** The core stands up as a
> resident MCP server, holds the teammate registry and a resident idle
> subscription, and **shells out to the unmodified `tm` for every verb**. No
> verb logic is reimplemented yet; that is Phase B, one verb at a time. `tm`
> is unchanged and remains fully usable on its own.

## Module layout

Every module under [`core/src/`](/plugins/claudemux/core/src) is small and
single-purpose; the testable logic is separated from the process wiring.

| Module | Role |
|---|---|
| `paths.ts` | Path builders for every `/tmp` protocol file and the core's own state — the path-builder discipline ([decision 0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md)) applied to the TypeScript side. |
| `tm.ts` | The shell-out layer — `runTm` spawns `tm` and captures its exit code, stdout, and stderr. The single seam Phase B migrates through. |
| `verbs.ts` | The catalog of `tm` verbs the core re-exposes as MCP tools. |
| `registry.ts` | The teammate registry — see below. |
| `subscription.ts` | The resident idle subscription — see below. |
| `core.ts` | Assembles the MCP tool list and dispatches a tool call: shell out, then reconcile the registry. Transport-agnostic and fully unit-tested. |
| `socket-transport.ts` | An MCP `Transport` over a unix-domain-socket connection. |
| `server.ts` | The process entry — loads and reconciles the registry, starts the subscription, and serves the socket. |

The core is reached over a **unix-domain socket** ([`paths.coreSocketPath`](/plugins/claudemux/core/src/paths.ts) —
`/tmp/claudemux-core.sock`), not stdio: it is resident and serves many
short-lived dispatcher connections, so its outward face cannot be the
per-process stdio transport feishu-channel uses. Each accepted connection
gets its own MCP `Server` bound to the one shared core.

## The teammate registry

The registry ([`registry.ts`](/plugins/claudemux/core/src/registry.ts)) is the
core's authoritative record of the teammate set — and the reason the core
exists rather than a `tmux ls` wrapper: a Codex teammate (Phase C) is a
persisted thread with no tmux session, so a tmux query cannot enumerate it.

**On-disk contract.** One JSON file at `~/.claude/claudemux/registry.json` —
under `~/.claude/`, not `/tmp`, so it survives a reboot. The shape:

```
{ "schemaVersion": 1, "teammates": [ TeammateEntry, ... ] }
```

Each `TeammateEntry` carries `repo` (the key — the sibling directory name),
`agent` (`claude` in Phase A; the field exists now so a Codex teammate needs
no schema bump), `sid` (the current Claude Code `session_id`, nullable — it
rotates on `/clear` and `/resume`, so it is a field, not a key), `cwd`, and
the `spawnedAt` / `observedAt` timestamps.

**Durability — the Phase A exit gate is "the registry survives a core
restart".** Two properties carry it:

- *Atomic writes.* Every save writes a sibling `.tmp` file and then `rename`s
  it over `registry.json`. A crash mid-save can leave a stale `.tmp` but never
  a torn registry file.
- *Tolerant loads.* A missing, truncated, or unparseable file — and a file
  written under a different `schemaVersion` — loads as an *empty* registry
  rather than throwing. A core that crashed into a bad file must still start.
  Phase A ships no schema migration: the registry is rebuildable from the live
  teammate set, so discard-and-reconcile is the safe move.

**Who writes it.** The core's `spawn` and `resume` tool handlers `record` a
teammate after a successful shell-out; `kill` `remove`s one. The mutating-verb
set is declared in `verbs.ts` (`registry: 'record' | 'remove' | 'none'`).

**Reconciliation.** At startup the core reloads the registry and drops every
teammate a liveness predicate rejects — a registry reloaded after a crash can
name teammates killed while the core was down. The Phase A predicate is "the
repo-keyed `.sid` file still exists" (`tm kill` removes it). This is a known
approximation — a teammate killed outside `tm` leaves a stale file; Phase B's
native `ls` gives reconciliation an authoritative source.

## The resident idle subscription

Because the core is resident it holds a live subscription to each teammate's
turn signal rather than polling for it. For a Claude teammate that signal is
the per-sid marker files the Bash hooks maintain under `/tmp/claude-idle/`
(see [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md)).

[`subscription.ts`](/plugins/claudemux/core/src/subscription.ts) is one
`fs.watch` on that directory, kept in an in-memory per-sid map so a teammate's
busy/idle state is a lookup, not a stat. Its Phase A reader is the
`teammates` MCP tool, which annotates each registry entry with its live
signal. Phase B attaches the native `wait` verb to the same watch.

## The MCP tool surface

The core exposes one MCP tool per `tm` verb — the whole verb set, since the
Phase A exit gate is "reproduces today's `tm` behavior for *every* verb". A
verb tool takes an opaque `args` string vector (and optional `stdin`)
forwarded verbatim to `tm`; rich per-argument schemas are otherwise a Phase D
task. The exception is the three registry-affecting verbs — `spawn`, `resume`,
`kill` — whose tools also take a **required structured `repo` field**: the
core needs the teammate identity as data to key the registry, and a named
field is robust to `tm`'s per-verb flag ordering (`tm resume` accepts flags
before the repo) where a positional guess is not. The `repo` is passed to
`tm` as the first argument; any further arguments still ride in `args`.

One tool is core-native rather than a `tm` passthrough: `teammates` lists the
registry, each entry annotated with its live signal. It overlaps with `tm ls`
during the migration on purpose — `ls` shells out to a tmux query, `teammates`
reads the persistent registry; Phase B merges them as `ls` migrates into the
core.

## See also

- [domains/mcp-native-orchestrator.md](/.agents/domains/mcp-native-orchestrator.md) — the architecture and the Phase A–D strangler migration.
- [decisions/0018-mcp-native-orchestration-core.md](/.agents/decisions/0018-mcp-native-orchestration-core.md) — why the core replaces `tm`.
- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the `/tmp` marker protocol the subscription reads.
- [components/tm.md](/.agents/components/tm.md) — the `tm` CLI the core fronts and will progressively hollow.
