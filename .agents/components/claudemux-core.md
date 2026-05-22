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

> **Status — the CLI front end stands; the hot path still shells out.** The
> structure is in place (domain-spec stage 2): the CLI front end dispatches
> every verb, the resident-MCP scaffolding is gone, and the runtime is Node.
> 11 of the 17 `tm` verbs run as native TypeScript; the remaining six — the
> racy hot path (`spawn`, `send`, `wait`, `compact`, `resume`) and `doctor` —
> still shell out to the Bash `tm`. Stage 3 migrates those and retires
> [`bin/tm`](/plugins/claudemux/bin/tm); stage 4 adds the Codex driver. The
> Bash `tm` is unchanged and fully usable on its own throughout.

## Module layout

Every module under [`core/src/`](/plugins/claudemux/core/src) is small and
single-purpose; the dispatch logic is kept separate from the process wiring.

| Module | Role |
|---|---|
| `cli.ts` | The CLI front end and process entry — parse the argument vector, run the verb through `runVerb`, write its stdout/stderr to the process streams, exit with its code. |
| `core.ts` | `runVerb` — the verb dispatch: per verb, run native TypeScript or shell out to `tm`. |
| `native.ts` | Native verb implementations — the verbs reimplemented in TypeScript. |
| `verbs.ts` | `TM_VERBS` — the catalog of the 17 `tm` verbs. |
| `proc.ts` | `spawnCapture` — the `node:child_process` spawn primitive every shell-out backend is built on. |
| `tm.ts` | The `tm` shell-out backend — `runTm` spawns the Bash `tm` for verbs not yet migrated; `runTmRaw` spawns it for a bare `tm`. It is also the backend the native `reload` fans out over. |
| `tmux.ts` | The `tmux` backend — `runTmux`, for natively-migrated verbs that still query tmux. |
| `column.ts` | The `column` backend — `runColumn` pipes tab-separated rows through `column -t` for table-rendering verbs. |
| `grep.ts` | The `grep` backend — `runGrep` matches input against a regex with `grep -qE` for the `poll` verb. |
| `paths.ts` | Path builders for every `/tmp` protocol file and `~/.claude/projects` path — the path-builder discipline ([decision 0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md)) on the TypeScript side. |

`tm` holds no state between invocations — a verb is one short-lived process.
The state it reads and mutates lives outside it: tmux sessions, the `/tmp`
marker protocol, and `~/.claude/projects`. See
[domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md)
§2–§3.

## Verb dispatch

`runVerb` ([`core.ts`](/plugins/claudemux/core/src/core.ts)) is the one place
that decides, per verb, whether to run native code or shell out:

- A **migrated** verb is a `NativeVerb` in
  [`native.ts`](/plugins/claudemux/core/src/native.ts); `runVerb` looks it up
  in `NATIVE_VERBS` and calls it.
- Every **other** verb shells out to the Bash `tm` through
  [`tm.ts`](/plugins/claudemux/core/src/tm.ts).
- A **`--help`** invocation shells out even for a migrated verb — `tm`'s own
  dispatcher prints the per-verb help, and a native handler carries no help
  text.

Either path produces the same `{code, stdout, stderr}` `TmResult`, so the CLI
front end shapes a verb's output one way regardless — that is what keeps the
migration drop-in.

A native verb keeps its *logic* in the core but may still shell out to a
session, presentation, or matching backend: the tmux-querying verbs reach
`tmux` through [`tmux.ts`](/plugins/claudemux/core/src/tmux.ts); `states` and
`history` pipe their rows through the real `column -t`
([`column.ts`](/plugins/claudemux/core/src/column.ts)); `poll` delegates its
regex match to the real `grep -qE` ([`grep.ts`](/plugins/claudemux/core/src/grep.ts)).
`column` and `grep` are not reimplemented in TypeScript — how `column` measures
a field's width and what `grep -E`'s POSIX dialect matches are implementation-
and platform-dependent, and the migration must preserve the installed binary's
exact behavior. `reload` itself shells out to a `tm send` subprocess: it is
sugar over `tm send`, which is not yet migrated. Every shell-out goes through
`spawnCapture` ([`proc.ts`](/plugins/claudemux/core/src/proc.ts)), the one
`node:child_process` primitive.

## The CLI front end

[`cli.ts`](/plugins/claudemux/core/src/cli.ts) is `tm` as a per-invocation
command. `runCli` takes the argument vector, splits off the verb, runs it
through `runVerb`, and returns the verb's `TmResult`; the process entry writes
that result's streams to `process.stdout` / `process.stderr` and exits with its
code. A bare `tm` (no verb) shells the empty argument vector out to the Bash
`tm`, which owns the no-verb help screen. Only `archive` reads stdin, so the
entry slurps `process.stdin` for that verb alone.

The front end is not yet wired as the installed `tm` — that is stage 3, where
the hot-path verbs migrate and the Bash [`bin/tm`](/plugins/claudemux/bin/tm)
is retired.

## Native verbs and the conformance harness

**The migration is behavior-preserving.** A native verb reproduces what `tm`
does today, down to the exact text of an error line, bug for bug; fixing a `tm`
behavior is a separate change, never folded into the migration. This is
enforced by the **conformance harness**
([`test/conformance.test.ts`](/plugins/claudemux/core/test/conformance.test.ts)):
for each migrated verb and a set of fixture scenarios it runs the real
`bin/tm` and the native handler against the *same* fixture and asserts their
`TmResult` values — exit code, stdout, and stderr — are equal. The oracle is
the live `tm`, re-derived on every run, not a golden file. tmux is faked — a
script both sides reach (`tm` through `PATH`, the native verb through
`CLAUDEMUX_TMUX`) — so the harness needs no real tmux.

Most scenarios are OS-agnostic, but not all: `tm history`'s detail view formats
a timestamp with BSD `date -r`, which is not portable to GNU, so those
scenarios are macOS-gated. The `claudemux-core` CI job therefore runs on both
Linux and macOS — the harness shells out to `tm`, whose cross-platform behavior
is itself what it pins.

A *mutating* verb cannot be checked by running the oracle and the native
handler against the same fixture: the oracle changes the world the native run
would then see. Such a scenario instead supplies a `snapshot` closure capturing
its "world" — for `kill`, its `/tmp` files, idle markers, and the session list;
for `archive`, the dispatcher's memory directory. The harness snapshots the
world, runs the oracle, snapshots the effect, resets the world, runs native,
and asserts the two post-states match (as well as the two `TmResult`s).

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
`resolveTmBinary` / `CLAUDEMUX_TM`, so stage 3's hot-path verb migration
re-aims the suite at the native verbs by pointing that override. Why trust is
seeded by a targeted
write rather than an isolated config dir is
[decision 0020](/.agents/decisions/0020-live-teammate-integration-harness.md);
the run instructions are the suite's own
[README](/plugins/claudemux/core/test/integration/README.md).

## See also

- [domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md) — the CLI architecture and the migration roadmap.
- [decisions/0019-node-cli-orchestrator.md](/.agents/decisions/0019-node-cli-orchestrator.md) — why the `next` line is a Node CLI.
- [decisions/0020-live-teammate-integration-harness.md](/.agents/decisions/0020-live-teammate-integration-harness.md) — how the live-teammate suite seeds trust and gates stage 3.
- [decisions/0018-mcp-native-orchestration-core.md](/.agents/decisions/0018-mcp-native-orchestration-core.md) — the superseded MCP-native design.
- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the `/tmp` marker protocol the Claude-teammate verbs read and write.
- [components/tm.md](/.agents/components/tm.md) — the Bash `tm` the core fronts and progressively hollows.
