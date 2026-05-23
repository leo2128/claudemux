# Component: the orchestration core (the `next` line)

The `core/` directory holds the TypeScript codebase of claudemux's **`next`**
line — the `1.0.0-beta.0` line developed in parallel with `main`'s 0.x. It
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

> **Status — the bash `tm` is retired; the codex driver has landed.**
> All 17 `tm` verbs are reimplemented in TypeScript and dispatched by
> [`cli.ts`](/plugins/claudemux/core/src/cli.ts); help text lives natively
> in [`help.ts`](/plugins/claudemux/core/src/help.ts). The user-installed
> [`bin/tm`](/plugins/claudemux/bin/tm) is a small bash launcher that
> `exec`s `node` against the esbuild bundle committed at
> [`core/dist/cli.mjs`](/plugins/claudemux/core/dist/cli.mjs); a dev launcher
> at [`core/bin/tm`](/plugins/claudemux/core/bin/tm) runs the same code
> through `tsx` so source edits need no rebuild. The conformance harness
> compares native output to committed golden JSON files under
> [`core/test/goldens/`](/plugins/claudemux/core/test/goldens) rather than a
> bash oracle.
>
> Stage 4 added the Codex driver — `tm spawn codex-<n>`, `tm send codex-<n>`,
> `tm wait codex-<n>`, `tm kill codex-<n>`, and `tm ask "<prompt>"` route
> through [`codex-verbs.ts`](/plugins/claudemux/core/src/codex-verbs.ts),
> backed by [`codex-supervisor.ts`](/plugins/claudemux/core/src/codex-supervisor.ts)
> for daemon lifecycle and [`codex-ws.ts`](/plugins/claudemux/core/src/codex-ws.ts)
> for the protocol. The wire schema is vendored as the output of
> `codex app-server generate-ts --experimental` under
> [`codex-protocol/`](/plugins/claudemux/core/src/codex-protocol) and pinned
> by a CI drift gate; see [decision 0022](/.agents/decisions/0022-codex-driver.md).

## Module layout

Every module under [`core/src/`](/plugins/claudemux/core/src) is small and
single-purpose; routing, verb code, and process wiring each have their own home.

| Module | Role |
|---|---|
| `main.ts` | The process entrypoint — read `process.argv` / `process.stdin`, hand to `runCli`, write the result's streams to `process`, set `process.exitCode`. esbuild bundles this file for production; the dev launcher runs it through `tsx`. |
| `cli.ts` | `runCli` and `productionEnv` — the per-invocation router (help pre-scan, `help <verb>` form, removed-verb migration messages, native dispatch, unknown-verb error) and the production backend wiring. |
| `help.ts` | `HELP_TEXTS`, `OVERVIEW_HELP`, `REMOVED_VERB_MESSAGES` — the user-facing help strings, the single source of truth that `tm <verb> --help` and `tm help <verb>` print. |
| `native.ts` | Every verb's implementation, plus `NATIVE_VERBS` keyed by verb name and `NativeEnv` (the injected backends). |
| `verbs.ts` | `TM_VERBS` — the catalog of the 17 `tm` verbs. |
| `proc.ts` | `spawnCapture` — the `node:child_process` spawn primitive every shell-out backend is built on. |
| `tm.ts` | `TmResult` / `TmRunOptions` types, and `resolveTmBinary` — the live-teammate harness's seam for locating the user-installed `tm` PATH entry (honors `CLAUDEMUX_TM`). |
| `tmux.ts` | The `tmux` backend — `runTmux`, used by every verb that queries tmux. |
| `column.ts` | The `column` backend — `runColumn` pipes tab-separated rows through `column -t` for table-rendering verbs. |
| `grep.ts` | The `grep` backend — `runGrep` matches input against a regex with `grep -qE` for the `poll` verb. |
| `paths.ts` | Path builders for every `/tmp` protocol file and `~/.claude/projects` path — the path-builder discipline ([decision 0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md)) on the TypeScript side. Includes the codex-daemon registry builders under `/tmp/teammate-codex/<name>/` (overridable via `CLAUDEMUX_CODEX_REGISTRY_ROOT` for tests). |
| `codex-verbs.ts` | The codex-teammate verbs — `codexSpawn`, `codexSend`, `codexWait`, `codexKill`, `codexAsk`, plus `isCodexTarget(name)` for the prefix fork. Each returns the same `TmResult` shape every other verb does. |
| `codex-supervisor.ts` | Daemon lifecycle — `spawnDaemon`, `daemonAlive`, `readDaemonState`, `listDaemons`, `reapDaemon`, and the per-call bookkeeping helpers. Owns spawn-detached, the unix-socket readiness probe, and SIGTERM-then-SIGKILL reap. |
| `codex-ws.ts` | The WebSocket JSON-RPC client. Routes incoming frames by envelope shape (`method+id+params` is a server-request, `method+params` is a notification, `id+result\|error` is a response), pinned by [`codex-schema.test.ts`](/plugins/claudemux/core/test/codex-schema.test.ts). |
| `codex-protocol/` | Generated by `codex app-server generate-ts --experimental`. Treat as vendored ground truth; the CI drift gate (`Install codex CLI` + `codex-protocol not stale`) regenerates it on every push and asserts the diff is empty. |

`tm` holds no state between invocations — a verb is one short-lived process.
The state it reads and mutates lives outside it: tmux sessions, the `/tmp`
marker protocol, and `~/.claude/projects`. See
[domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md)
§2–§3.

## Verb dispatch

`runCli` ([`cli.ts`](/plugins/claudemux/core/src/cli.ts)) is the one place
that routes one CLI invocation. The order mirrors the bash `main` it replaced:

1. Bare `tm` → `OVERVIEW_HELP`, exit 0.
2. `tm help` / `tm -h` / `tm --help` / `tm help <verb>` → the matching entry
   from `HELP_TEXTS`, or `OVERVIEW_HELP`; an unknown verb here writes a
   stderr line plus the overview and exits 1.
3. Help pre-scan on the verb's argument list — a `-h`/`--help` before the
   first positional or before `--prompt` prints that verb's help; otherwise
   the scan stops and dispatch proceeds.
4. Removed verb (`ask`, `wait-idle`, `wait-quiet`) → the migration message
   from `REMOVED_VERB_MESSAGES`, exit 2.
5. Native verb → `NATIVE_VERBS[verb]` is called with the argument tail.
6. Unknown verb → stderr line plus overview, exit 1.

Every path produces the same `{code, stdout, stderr}` `TmResult`. The process
entry in [`main.ts`](/plugins/claudemux/core/src/main.ts) writes that result
to `process.stdout` / `process.stderr` and exits with its code.

A native verb keeps its *logic* in the core but may still shell out to a
session, presentation, or matching backend: the tmux-querying verbs reach
`tmux` through [`tmux.ts`](/plugins/claudemux/core/src/tmux.ts); `states` and
`history` pipe their rows through the real `column -t`
([`column.ts`](/plugins/claudemux/core/src/column.ts)); `poll` delegates its
regex match to the real `grep -qE` ([`grep.ts`](/plugins/claudemux/core/src/grep.ts)).
`column` and `grep` are not reimplemented in TypeScript — how `column` measures
a field's width and what `grep -E`'s POSIX dialect matches are implementation-
and platform-dependent, and the migration must preserve the installed binary's
exact behavior. `reload` calls native `send` in-process (no subprocess); every
remaining shell-out goes through `spawnCapture`
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
`require_session` / `repo not found` paths, and `send --no-wait` (which
returns as soon as the keys are dispatched). The full round-trip is the
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
