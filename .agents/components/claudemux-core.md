# Component: the orchestration core (the `next` line)

The `core/` directory holds the TypeScript codebase of claudemux's **`next`**
line — the `1.0.0` line developed in parallel with `main`'s 0.x. It
lives at [`/plugins/claudemux/core/`](/plugins/claudemux/core), alongside the
Bash plugin, and runs on **Node** (the test suite uses `vitest`).

[Decision 0019](/.agents/decisions/0019-node-cli-orchestrator.md) set the
shape: the `next` line's orchestrator is a **pure Node CLI** — `tm` rewritten
from the Bash script into TypeScript, invoked once per command, with no
resident process and no MCP server. The architecture and the migration roadmap
are the domain spec,
[domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md);
this document is the **component** view — what the `core/` modules are and what
contracts they hold.

> **Status — Phase 2a-3 routes teammate verbs through the Engine layer.**
> All 18 `tm` verbs are implemented in TypeScript and dispatched by
> [`cli.ts`](/plugins/claudemux/core/src/cli.ts); help text lives in
> [`help.ts`](/plugins/claudemux/core/src/help.ts). The user-installed
> [`bin/tm`](/plugins/claudemux/bin/tm) is a small bash launcher that
> `exec`s `node` against the esbuild bundle committed at
> [`core/dist/cli.mjs`](/plugins/claudemux/core/dist/cli.mjs); a dev launcher
> at [`core/bin/tm`](/plugins/claudemux/core/bin/tm) runs the same code
> through `tsx` so source edits need no rebuild. The conformance harness
> compares native output to committed golden JSON files under
> [`core/test/goldens/`](/plugins/claudemux/core/test/goldens).
>
> [Decision 0024](/.agents/decisions/0024-multi-engine-tui-architecture.md)
> shapes the core around an `Engine` interface, a single `TeammateRecord`
> JSON keyed by name, and a verb layer that fans out across engines. The
> load-bearing infrastructure is shared persistence + identity modules
> ([`persistence/`](/plugins/claudemux/core/src/persistence) and
> [`identity/`](/plugins/claudemux/core/src/identity)), the `Engine` contract
> ([`engines/`](/plugins/claudemux/core/src/engines)), concrete
> `ClaudeEngine` and `CodexEngine` implementations, and verb modules under
> [`verbs/`](/plugins/claudemux/core/src/verbs). Teammate-targeted verbs
> (`ls`, `states`, `status`, `kill`, `spawn`, `send`, `wait`, `compact`,
> `resume`, `last`, `ctx`, `history`, `mem`, `reload`) route through
> `verbs/<v>.ts` -> router / `EngineRegistry` -> engine. Dispatcher-only and
> diagnostic verbs (`archive`, `poll`, `doctor`, `ask`) stay local to the CLI
> or their dedicated helper modules.
>
> Codex teammates are driven by `CodexEngine`. `tm spawn codex-<n>`,
> `tm send codex-<n>`, `tm wait codex-<n>`, `tm resume codex-<n> <thread-id>`,
> `tm kill codex-<n>`, and Codex liveness verbs route through the generic verb layer and
> [`plugins/claudemux/core/src/engines/codex/engine.ts`](/plugins/claudemux/core/src/engines/codex/engine.ts).
> `tm status`, `tm ls`, and `tm states` combine daemon registry health,
> socket reachability, `thread/read` status when available, and recent
> rollout writes; `tm states` renders LAST / PREVIEW from the current
> thread's latest assistant text when the rollout is present. `tm last`,
> `tm ctx`, and `tm history` read Codex's
> append-only rollout JSONL files under `~/.codex/sessions/YYYY/MM/DD/`;
> `tm history` filters them by recorded cwd and lists thread ids for
> `tm resume`.
> `tm resume <name> <thread-id>` starts a fresh per-teammate daemon, writes
> the thread id back to `/tmp/teammate-codex/<name>/thread`, and calls
> `thread/resume`; for killed non-prefix Codex names, `verbs/resume.ts` uses
> the rollout filename as the durable routing hint.
> `tm ask "<prompt>"` uses
> [`plugins/claudemux/core/src/engines/codex/verbs.ts`](/plugins/claudemux/core/src/engines/codex/verbs.ts).
> Daemon lifecycle lives in
> [`plugins/claudemux/core/src/engines/codex/supervisor.ts`](/plugins/claudemux/core/src/engines/codex/supervisor.ts),
> the JSON-RPC client lives in
> [`plugins/claudemux/core/src/engines/codex/rpc.ts`](/plugins/claudemux/core/src/engines/codex/rpc.ts),
> event collection lives in
> [`plugins/claudemux/core/src/engines/codex/events.ts`](/plugins/claudemux/core/src/engines/codex/events.ts),
> rollout readers live in
> [`plugins/claudemux/core/src/engines/codex/rollout.ts`](/plugins/claudemux/core/src/engines/codex/rollout.ts),
> and Codex persistence paths live in
> [`plugins/claudemux/core/src/engines/codex/persistence.ts`](/plugins/claudemux/core/src/engines/codex/persistence.ts).
> The wire schema is vendored as the output of
> `codex app-server generate-ts --experimental` under
> [`codex-protocol/`](/plugins/claudemux/core/src/codex-protocol) and pinned
> by a CI drift gate; see [decision 0022](/.agents/decisions/0022-codex-driver.md).

## Module layout

Every module under [`core/src/`](/plugins/claudemux/core/src) is small and
single-purpose; routing, verb code, and process wiring each have their own home.

| Module | Role |
|---|---|
| `main.ts` | The process entrypoint — read `process.argv` / `process.stdin`, hand to `runCli`, write the result's streams to `process`, set `process.exitCode`. esbuild bundles this file for production; the dev launcher runs it through `tsx`. |
| `cli.ts` | `runCli` and `productionEnv` — the per-invocation router (help pre-scan, `help <verb>` form, removed-verb migration messages, engine-routed dispatch for teammate-targeted verbs, dispatcher-only / diagnostic dispatch for `archive` / `poll` / `doctor` / `ask`, unknown-verb error) and the production backend wiring. |
| `help.ts` | `HELP_TEXTS`, `OVERVIEW_HELP`, `REMOVED_VERB_MESSAGES` — the user-facing help strings, the single source of truth that `tm <verb> --help` and `tm help <verb>` print. |
| `verbs.ts` | `TM_VERBS` — the catalog of the 18 `tm` verbs. |
| `verbs/` | Verb-layer dispatch — `verbs/{ls,states,status,kill,spawn,send,wait,compact,resume,last,ctx,history,mem,reload}.ts` build engine requests, resolve teammate names through `identity/router.ts`, call engine methods, and format discriminated results through `verbs/format.ts`. `verbs/{ask,archive,poll}.ts` are local dispatcher / diagnostic helpers. |
| `engines/engine.ts`, `engines/types.ts`, `engines/registry.ts`, `engines/teammate-record.ts` | The `Engine` interface, the shared request/result/value types (decision 0024 §"Engine interface" and §"Capabilities"), the invocation-scoped `EngineRegistry`, and the abstract `TeammateRecord` base whose subclasses live under `engines/<kind>/persistence.ts`. |
| `engines/claude/` | The Claude engine. `claude-engine.ts` implements `Engine`; `persistence.ts` owns the `.cwd` / `.sid` / `.ready` / `.send-at` builders and the `tmuxSessionName` encoding for nested teammate names (decision 0024 §"Nested teammate names"). The verb bodies live in `engines/claude/<verb>.ts` and are reached through the verb layer. |
| `engines/codex/` | The Codex engine. `engine.ts` implements `Engine`; `persistence.ts` owns the base record plus `/tmp/teammate-codex/<name>/` registry-directory builders; `rollout.ts` reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` for last replies, token usage, activity fallback, and killed-name resume routing; `history.ts` lists and expands rollout-backed thread ids for `tm history`. Codex-supported verbs use the app-server daemon; unsupported teammate verbs return structured `not-supported` results through the same Engine method surface. |
| `persistence/atomic-file.ts` | Atomic write primitives (`atomicWrite`, `reserveExclusive`, `readIfPresent`) — every teammate-record write goes through these so a concurrent verb never observes a torn file. |
| `persistence/identity-store.ts` | The only file that writes / reads `/tmp/teammate-<name>.json` — decision 0024 §"TeammateRecord" enforcement. `reserve` is the `O_CREAT \| O_EXCL` spawn-time race winner; `list()` recursively scans `/tmp/teammate*` (including the Codex registry root, since `codex/foo`'s base record lives at `/tmp/teammate-codex/foo.json`) and relies on schema parse + path-segment reconstruction to keep daemon-private files out of the listing. Identity root is overridable via `CLAUDEMUX_IDENTITY_ROOT` for tests. |
| `persistence/project-dir.ts` | `encodeProjectDir` — Claude Code's on-disk projects-dir encoding ([decision 0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md) one-source-of-truth). |
| `persistence/identity-writer.ts` | `ProductionIdentityStore` — the verb-layer-facing `IdentityStore.remove()` seam (`killVerb` uses it after a successful kill). |
| `identity/name.ts` | `validateTeammateName` — single-segment + nested-name (`flow/flow-1`) validator. Rejects `__` only when the name also contains `/` (the one case where the `/` → `__` tmux encoding would round-trip ambiguously); legacy flat names like `flow__1` remain reachable. |
| `identity/router.ts` | `ProductionTeammateRouter` reads the identity JSON; `LegacyClaudeTmuxRouter` falls back to a tmux session probe for Claude teammates that predate the base JSON record; `CompositeTeammateRouter` chains them. |
| `proc.ts` | `spawnCapture` — the `node:child_process` spawn primitive every shell-out backend is built on. |
| `tm.ts` | `TmResult` / `TmRunOptions` types, and `resolveTmBinary` — the live-teammate harness's seam for locating the user-installed `tm` PATH entry (honors `CLAUDEMUX_TM`). |
| `tmux.ts` | The `tmux` backend — `runTmux`, used by every verb that queries tmux. |
| `column.ts` | The `column` backend — `runColumn` pipes tab-separated rows through `column -t` for table-rendering verbs. |
| `grep.ts` | The `grep` backend — `runGrep` matches input against a regex with `grep -qE` for the `poll` verb. |
| `paths.ts` | Path builders for the shared Claude `/tmp` protocol files and `~/.claude/projects` paths — the path-builder discipline ([decision 0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md)) on the TypeScript side. |
| [`plugins/claudemux/core/src/engines/codex/engine.ts`](/plugins/claudemux/core/src/engines/codex/engine.ts) | `CodexEngine implements Engine`: spawn/send/wait/list/status/kill/resume/last/ctx/history, with `resume` relaunching a daemon by thread id, `history` listing rollout-backed thread ids by cwd, `list` and `status` probing daemon health plus Codex thread status, and structured not-supported results for capabilities Codex does not expose. |
| [`plugins/claudemux/core/src/engines/codex/verbs.ts`](/plugins/claudemux/core/src/engines/codex/verbs.ts) | Thin compatibility helpers around `CodexEngine` for Codex-specific callers and tests, plus `codexAsk` for the pool-borrow diagnostic path. The main teammate-targeted CLI dispatch goes through `verbs/<v>.ts` and the Engine registry. |
| [`plugins/claudemux/core/src/engines/codex/supervisor.ts`](/plugins/claudemux/core/src/engines/codex/supervisor.ts) | Per-teammate daemon lifecycle — `spawnDaemon`, `daemonAlive`, `readDaemonState`, `listDaemons`, `reapDaemon`, and the per-call bookkeeping helpers. Owns spawn-detached, lock-based duplicate-spawn protection, the unix-socket readiness probe, and SIGTERM-then-SIGKILL reap. |
| [`plugins/claudemux/core/src/engines/codex/rpc.ts`](/plugins/claudemux/core/src/engines/codex/rpc.ts) | The WebSocket JSON-RPC client. Routes incoming frames by envelope shape (`method+id+params` is a server-request, `method+params` is a notification, `id+result\|error` is a response), pinned by [`plugins/claudemux/core/test/codex-schema.test.ts`](/plugins/claudemux/core/test/codex-schema.test.ts). |
| [`plugins/claudemux/core/src/engines/codex/events.ts`](/plugins/claudemux/core/src/engines/codex/events.ts) | Codex-private event collector. It subscribes to `item/completed` and `turn/completed`, filters by `threadId`, buckets by `turnId`, and returns a merged turn to the engine. |
| [`plugins/claudemux/core/src/engines/codex/rollout.ts`](/plugins/claudemux/core/src/engines/codex/rollout.ts) | Read-only Codex rollout JSONL helpers. They locate `rollout-<timestamp>-<thread-id>.jsonl`, extract the latest assistant text and token count, and expose a short activity window used when live thread status is unavailable. |
| [`plugins/claudemux/core/src/engines/codex/history.ts`](/plugins/claudemux/core/src/engines/codex/history.ts) | Codex `tm history` implementation. It scans rollout files by date directory, filters by recorded cwd, marks the live thread from `/tmp/teammate-codex/<name>/thread`, and renders list / detail output with a `tm resume <name> <thread-id>` line. |
| [`plugins/claudemux/core/src/engines/codex/persistence.ts`](/plugins/claudemux/core/src/engines/codex/persistence.ts) | Codex teammate persistence builders: base-record helpers plus `/tmp/teammate-codex/<name>/pid`, `socket`, `thread`, `started-at`, `last-seen`, `stdout.log`, `stderr.log`, and `meta.json`. |
| `codex-protocol/` | Generated by `codex app-server generate-ts --experimental`. Treat as vendored ground truth; the CI drift gate (`Install codex CLI` + `codex-protocol not stale`) regenerates it on every push and asserts the diff is empty. |

`tm` holds no state between invocations — a verb is one short-lived process.
The state it reads and mutates lives outside it: tmux sessions, the `/tmp`
marker protocol, and `~/.claude/projects`. See
[domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md)
§2–§3.

## Verb dispatch

`runCli` ([`cli.ts`](/plugins/claudemux/core/src/cli.ts)) is the one place
that routes one CLI invocation. The order:

1. Bare `tm` → `OVERVIEW_HELP`, exit 0.
2. `tm help` / `tm -h` / `tm --help` / `tm help <verb>` → the matching entry
   from `HELP_TEXTS`, or `OVERVIEW_HELP`; an unknown verb here writes a
   stderr line plus the overview and exits 1.
3. Help pre-scan on the verb's argument list — a `-h`/`--help` before the
   first positional or before `--prompt` prints that verb's help; otherwise
   the scan stops and dispatch proceeds.
4. Removed verb (`wait-idle`, `wait-quiet`) → the migration message from
   `REMOVED_VERB_MESSAGES`, exit 2.
5. **Engine-routed teammate verbs** — `tm ls`, `tm states`, `tm status`,
   `tm kill`, `tm spawn`, `tm send`, `tm wait`, `tm compact`, `tm resume`,
   `tm last`, `tm ctx`, `tm history`, `tm mem`, and `tm reload` build a
   `productionVerbContext` (`EngineRegistry` registered with `ClaudeEngine`
   and `CodexEngine`, `CompositeTeammateRouter` composing the identity-store
   lookup with the legacy tmux-session probe, and `ProductionIdentityStore`
   for identity removal) and hand off through `verbs/<v>.ts`.
5b. **Dispatcher-only / diagnostic verbs** — `tm archive` lives in
   `verbs/archive.ts` and touches only the dispatcher's own ledger files under
   `~/.claude/projects/<encoded>/memory/`; `tm poll` remains a Claude/tmux
   diagnostic; `tm doctor` assembles local health checks; `tm ask` borrows a
   Codex teammate from the pool for a one-off review turn.
6. Unknown verb → stderr line plus overview, exit 1.

Every path produces the same `{code, stdout, stderr}` `TmResult`. The process
entry in [`main.ts`](/plugins/claudemux/core/src/main.ts) writes that result
to `process.stdout` / `process.stderr` and exits with its code.

An engine method keeps its *logic* in the core but may still shell out to a
session, presentation, or matching backend: Claude's tmux-querying methods
reach `tmux` through [`tmux.ts`](/plugins/claudemux/core/src/tmux.ts); `states`
pipes rows through the real `column -t`
([`column.ts`](/plugins/claudemux/core/src/column.ts)); `poll` delegates its
regex match to the real `grep -qE` ([`grep.ts`](/plugins/claudemux/core/src/grep.ts)).
`column` and `grep` are not reimplemented in TypeScript — how `column` measures
a field's width and what `grep -E`'s POSIX dialect matches are implementation-
and platform-dependent, and the migration must preserve the installed binary's
exact behavior. Process-launch shell-outs go through `spawnCapture`
([`proc.ts`](/plugins/claudemux/core/src/proc.ts)), the one
`node:child_process` primitive.

## Two launchers

Two thin shell scripts reach the same TypeScript code through different
runtimes:

- **Production**: [`bin/tm`](/plugins/claudemux/bin/tm) at the plugin root
  `exec`s `node` against the committed esbuild bundle
  [`core/dist/cli.mjs`](/plugins/claudemux/core/dist/cli.mjs). A marketplace
  install of the plugin does not run `npm install`, so the bundle is
  committed to the repo and the launcher needs only `node` on `PATH`. CI
  rebuilds the bundle from current source and asserts
  `git diff --exit-code dist/` so a feature commit cannot leave a stale
  bundle.
- **Development**: [`core/bin/tm`](/plugins/claudemux/core/bin/tm) `exec`s
  `tsx` against `core/src/main.ts` — source edits take effect immediately
  with no rebuild step. The live-teammate integration suite points
  `CLAUDEMUX_TM` here to drive the native verbs against a real teammate.

## Native verbs and the conformance harness

The **conformance harness**
([`test/conformance.test.ts`](/plugins/claudemux/core/test/conformance.test.ts))
pins each native verb's behavior against a committed **golden** JSON file
per scenario at
[`test/goldens/<verb>/<slug>.json`](/plugins/claudemux/core/test/goldens). For
each scenario the harness runs the native handler once and asserts its
`{code, stdout, stderr}` matches the golden; a mutating verb (`kill`,
`archive`, `reload`) additionally pins its post-state to a sibling
`<slug>.fs.json`. tmux is faked — the native verb reaches it through
`CLAUDEMUX_TMUX` — so the harness needs no real tmux. The wall clock and the
per-scenario name generator are both deterministic, so goldens are byte-
stable across runs.

To regenerate the goldens from current source (after an intended behavior
change) run:

```bash
UPDATE_GOLDENS=1 npx vitest run test/conformance.test.ts
```

and review the `git diff` before committing.

Most scenarios are OS-agnostic, but not all: `tm history`'s detail view
formats a timestamp with platform-flavored helpers, so those scenarios are
macOS-gated. The `claudemux-core` CI job therefore runs on both Linux and
macOS — the native verbs themselves still shell out to platform-sensitive
binaries (`column`, `grep`), and that surface is what the cross-platform
matrix pins.

The hot-path verbs (`spawn`, `send`, `wait`, `compact`, `resume`) cannot run
their full round-trip under the conformance fake — there is no real `claude`
REPL, and the fake `tmux` does not model `send-keys` / `load-buffer` /
`paste-buffer` faithfully. They are conformance-checked only at every exit
*before* the tmux send path: argument parsing, validation errors, the
`require_session` / `repo not found` paths, and other pre-send guardrails. The
full round-trip is the
[live-teammate suite's](/plugins/claudemux/core/test/integration) job.

`doctor` is migrated but not in the conformance harness: it reports the path
to the *current* `tm` binary, which differs between the production launcher
and the dev launcher. A native-only unit test in `cli.test.ts` pins the
verb's output structure.

Help text and removed-verb migration messages are pinned by `cli.test.ts`'s
assertions against `HELP_TEXTS` / `OVERVIEW_HELP` / `REMOVED_VERB_MESSAGES`
in [`help.ts`](/plugins/claudemux/core/src/help.ts) — that module is itself
the golden. A reviewer sees help changes as `help.ts` diffs in the same
commit that changes the verb.

## The live-teammate integration harness

The conformance harness fakes tmux and runs no `claude`, so it cannot reach the
racy hot path — `spawn`, `send`, `wait`, `compact`, `resume` — whose behavior
is the interaction of `tmux send-keys`, a real REPL, the claudemux hooks, and
the `/tmp/claude-idle` turn signal. The **live-teammate integration harness**
([`test/integration/`](/plugins/claudemux/core/test/integration)) covers that
gap: it spawns real `claude` teammates through `tm` and asserts the round-trips
complete.

It is opt-in — slow, and it needs a working Claude Code install — so it runs
under its own [`vitest.integration.config.ts`](/plugins/claudemux/core/vitest.integration.config.ts)
and its files are named `*.itest.ts`, never discovered by `npm test` or CI.
[`harness.ts`](/plugins/claudemux/core/test/integration/harness.ts) is the
framework: a temp-dispatcher fixture, a `tm` runner, the `~/.claude.json`
directory-trust seeding a teammate needs to boot past the workspace-trust
dialog, and a precondition probe that *skips* the suite — rather than failing
it — when no live teammate can run. Every `tm` call resolves through
`resolveTmBinary` / `CLAUDEMUX_TM`, so pointing that override at
[`core/bin/tm`](/plugins/claudemux/core/bin/tm) re-aims the suite at the
native CLI:

```bash
cd plugins/claudemux/core
CLAUDEMUX_TM=$(pwd)/bin/tm npx vitest run --config vitest.integration.config.ts
```

Why trust is seeded by a targeted write rather than an isolated config dir
is [decision 0020](/.agents/decisions/0020-live-teammate-integration-harness.md);
the run instructions are the suite's own
[README](/plugins/claudemux/core/test/integration/README.md).

## See also

- [domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md) — the CLI architecture and the migration roadmap.
- [decisions/0019-node-cli-orchestrator.md](/.agents/decisions/0019-node-cli-orchestrator.md) — why the `next` line is a Node CLI.
- [decisions/0020-live-teammate-integration-harness.md](/.agents/decisions/0020-live-teammate-integration-harness.md) — how the live-teammate suite seeds trust and gates stage 3.
- [decisions/0018-mcp-native-orchestration-core.md](/.agents/decisions/0018-mcp-native-orchestration-core.md) — the superseded MCP-native design.
- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the `/tmp` marker protocol the Claude-teammate verbs read and write.
- [components/tm.md](/.agents/components/tm.md) — the Bash `tm` the core fronts and progressively hollows.
