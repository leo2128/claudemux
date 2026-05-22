# Live-teammate integration suite

This directory drives the **racy hot-path verbs** — `spawn`, `send`, `wait`,
`compact`, `resume` — against a real `claude` teammate in a real tmux session.

The conformance harness (`test/conformance.test.ts`) pins the migrated verbs to
`tm`'s behavior with a *faked* tmux and no `claude` process. It cannot reach
the hot path, whose correctness is the interaction of `tmux send-keys`, a live
REPL, the claudemux hooks, and the `/tmp/claude-idle` turn signal. This suite
exercises exactly that.

## Files

| File | Role | Run by |
|---|---|---|
| `harness.ts` | The framework — dispatcher fixture, `tm` runner, trust seeding, the live precondition probe. | imported |
| `harness.test.ts` | Unit tests for the harness's pure pieces (the `~/.claude.json` transforms). Fast, no teammate. | `npm test` (and CI) |
| `hot-path.itest.ts` | The live suite — one ordered lifecycle against a shared teammate. Slow; real Claude Code turns. | `--config` only |

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

See [decision 0020](/.agents/decisions/0020-live-teammate-integration-harness.md)
for why trust is seeded this way rather than via an isolated config dir.

## Re-aiming the suite at the native verbs

Every `tm` call resolves through `resolveTmBinary` (`src/tm.ts`), which honors
the `CLAUDEMUX_TM` environment override. The suite runs against the Bash
`bin/tm` today; once the hot-path verbs are migrated to native code, pointing
`CLAUDEMUX_TM` at the native CLI re-aims this whole suite at it unchanged.
