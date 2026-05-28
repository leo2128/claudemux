# Live-teammate integration suite

This directory drives the **racy hot-path verbs** — `spawn`, `send`, `wait`,
`compact`, `resume`, plus `ask` on the codex driver — against a real teammate
of each kind: a `claude` REPL inside tmux, and a `codex app-server` reached
over a unix-socket WebSocket.

The conformance harness (`test/conformance.test.ts`) pins the migrated verbs to
`tm`'s behavior with a *faked* tmux and no `claude` process; the unit
suite for the codex driver fakes the daemon with a node shim that binds
a socket and speaks a minimal protocol subset. The real protocol-layer
behavior only proves out against the real binaries — that is this suite's job.

## Files

| File | Role | Run by |
|---|---|---|
| `harness.ts` | The framework — dispatcher fixture, `tm` runner, trust seeding, the live precondition probe. | imported |
| `harness.test.ts` | Unit tests for the harness's pure pieces (the `~/.claude.json` transforms). Fast, no teammate. | `npm test` (and CI) |
| `hot-path.itest.ts` | The live Claude suite — one ordered lifecycle against a shared teammate. Slow; real Claude Code turns. | `--config` only |
| `codex.itest.ts` | The live codex suite — smoke (spawn/doctor/kill, no turn spend) and an opt-in turn-spending slice (`tm send`, `tm ask`). | `--config` only |

## Running it

```bash
cd plugins/claudemux/core
npx vitest run --config vitest.integration.config.ts
```

`*.itest.ts` files are not `*.test.ts`, so `npm test` never discovers them and
neither does CI. The suite runs only when invoked with the config above.

## Prerequisites

The suite **skips itself** (with a printed reason) when these are not met — it
does not fail. `probeLiveTeammate` checks them before any test runs:

- `claude` and `tmux` are on `PATH`.
- `~/.claude.json` exists — Claude Code has been set up on this machine.
- The **claudemux plugin is enabled** for teammate sessions. The probe spawns a
  throwaway teammate and confirms its SessionStart hook fired; if it did not,
  the teammate has no hooks and the suite skips.

It also needs an authenticated `claude` (the teammate takes real turns) and
network access. Each run costs a handful of model turns.

## What it touches, and what it does not

- It seeds per-directory **trust** for its fixture repos into `~/.claude.json`
  — a targeted add/remove of the harness's own `projects.<temp-path>` keys, not
  a wholesale rewrite. The teardown removes them again.
- Teammates run on the **shared tmux server** under uniquely-named
  `teammate-claudemux-itest-*` sessions; teardown kills them, and a
  signal/exit handler kills any a crash leaks.
- It does not modify `~/.claude/settings.json`, the plugin install, or any
  production code.

See [decision live-teammate-integration-harness](/.agents/decisions/live-teammate-integration-harness.md)
for why trust is seeded this way rather than via an isolated config dir.

## codex.itest.ts — live codex driver

`codex.itest.ts` skips itself when `codex` is not on PATH or
`~/.codex/auth.json` is missing — running it must never accidentally fail
a local dev box without codex set up.

The suite uses its own throwaway registry root (`/tmp/cmxlive-XXX/`) via
`CLAUDEMUX_CODEX_REGISTRY_ROOT`, so the user's production
`/tmp/teammate-codex/` is untouched. `CLAUDEMUX_CODEX_BIN` is honored,
so a non-default codex install can be pointed at by setting that env.

The suite has two slices:

- **Smoke** runs by default when codex is available. It spawns one
  daemon, observes `tm doctor` reports it, kills its process out of
  band so the next doctor pass reaps a dead-pid orphan, and confirms
  `tm kill` is a no-op on the already-gone teammate. No model usage.
- **Turn-spending** is gated by `CLAUDEMUX_CODEX_SPEND_TOKENS=1` and
  drives real `tm send` + `tm ask` turns. Each turn costs OpenAI
  credits; the gate keeps a routine `--config` run cheap.

```bash
# Smoke only — no token spend.
npx vitest run --config vitest.integration.config.ts test/integration/codex.itest.ts

# Smoke + turn-spending slice.
CLAUDEMUX_CODEX_SPEND_TOKENS=1 npx vitest run --config vitest.integration.config.ts test/integration/codex.itest.ts
```

## Pointing the suite at a custom launcher

Every `tm` call resolves through `resolveTmBinary` (`src/tm.ts`), which honors
the `CLAUDEMUX_TM` environment override. Default resolution points at the
user-facing launcher at `plugins/claudemux/bin/tm`; set `CLAUDEMUX_TM` to
any other launcher (a checked-out fork, a wrapper for profiling) to re-aim
the whole suite without touching the harness.
