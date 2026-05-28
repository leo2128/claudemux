# Live-teammate integration tests seed trust by a targeted `~/.claude.json` write

- **Status:** Accepted
- **Date:** 2026-05-23
- **Affects:** the **`next`** line's test surface — [`core/test/integration/`](/plugins/claudemux/test/integration), [`core/vitest.integration.config.ts`](/plugins/claudemux/vitest.integration.config.ts). This is the harness the hot-path verb migration ([roadmap](/.agents/domains/node-cli-orchestrator.md) stage 3) is gated on; it lands first, ahead of that migration.

## Context

The conformance harness ([`core/test/conformance.test.ts`](/plugins/claudemux/test/conformance.test.ts))
pins the migrated verbs to `tm`'s behavior with a *faked* tmux and no `claude`
process. It cannot reach the racy hot path — `spawn`, `send`, `wait`,
`compact`, `resume` — whose correctness is the interaction of `tmux send-keys`,
a real `claude` REPL, the claudemux hooks, and the `/tmp/claude-idle` turn
signal actually firing. Migrating those verbs (stage 3) needs a test that
drives a real teammate; that test must exist *before* the migration, so the
migration lands under a working net rather than ahead of one.

Standing up a real teammate surfaced two non-obvious facts, found empirically:

- **A teammate in a fresh directory hangs on the workspace-trust dialog.** A
  `claude` REPL started in a never-before-seen directory shows a blocking "do
  you trust this folder?" prompt. A teammate has no human to answer it, so its
  SessionStart/Stop hooks never fire and every `tm send` times out. Trust state
  lives in `~/.claude.json` under `projects.<path>.hasTrustDialogAccepted`;
  there is no environment variable or settings key that bypasses the dialog
  (`claude -p` non-interactive mode skips it, but a teammate is an interactive
  REPL).
- **An isolated `CLAUDE_CONFIG_DIR` cannot carry auth.** The clean-isolation
  option — give the teammate a private `CLAUDE_CONFIG_DIR` holding its own
  trust and plugin state, so the real user config is never touched — was
  tested and rejected. `CLAUDE_CONFIG_DIR` *is* honored and the plugin *does*
  load from a symlinked `plugins/`, but an isolated config dir reports "Not
  logged in", and seeding it (both bare and with a full copy of the real
  `~/.claude.json`) did not restore auth. Authentication does not follow an
  isolated config dir.

## Decision

Live-teammate integration tests live in
[`core/test/integration/`](/plugins/claudemux/test/integration), run under
a dedicated [`vitest.integration.config.ts`](/plugins/claudemux/vitest.integration.config.ts),
and are named `*.itest.ts` so the default `npm test` (and CI) never discover
them. The suite is test-only — it adds no production code.

- **Trust is seeded by a targeted read-modify-write of the real
  `~/.claude.json`.** The harness adds `projects.<fixture-path>.hasTrustDialogAccepted`
  for its temp fixture repos before the run and removes those keys after — only
  ever its own keys, never a wholesale save/restore. A wholesale restore would
  blindly write back a stale snapshot and clobber the concurrent writes every
  other Claude Code process makes to that file. Isolation via `CLAUDE_CONFIG_DIR`
  is not used, because it cannot carry auth (see Context).
- **The claudemux plugin is a precondition, not something the harness
  injects.** `probeLiveTeammate` spawns one throwaway teammate and checks its
  SessionStart hook fired (`tm spawn` prints `ready:` when it did, `WARN:`
  when it did not); the suite skips with a reason if not. Reproducing the
  plugin's hook bundle in project settings was rejected — where the plugin is
  already enabled it would double-fire every hook, for no gain.
- **Teammates run on the shared tmux server**, under uniquely-named
  `teammate-claudemux-itest-<label>-<rand>` sessions. The hot-path verbs have
  no `--all` fan-out, so unique names contain the blast radius; teardown plus a
  signal/exit handler kill every teammate a run spawns.
- **The suite reaches `tm` through `resolveTmBinary` / `CLAUDEMUX_TM`.** It
  runs against the Bash `bin/tm` today; stage 3's hot-path verb migration
  re-aims it at the native verbs by pointing that override at the native CLI,
  with the harness itself unchanged.

## Consequences

- The targeted RMW still has a clobber window — the few milliseconds between
  the harness reading `~/.claude.json` and renaming its rewrite over it. A
  concurrent Claude Code write that lands inside that window is lost. Accepted:
  the window is tiny, the write only ever touches the harness's own
  `projects.<temp-path>` keys, and the cleaner alternative (an isolated config
  dir) is empirically blocked by auth.
- The suite cannot run in CI — there is no `claude` binary and no auth there —
  by design. The hot-path verb migration's merge bar is therefore "CI green
  **and** a reported green run of this suite", not pure CI green.
- Running the suite needs `~/.claude.json` present, `claude` and `tmux`
  installed, the claudemux plugin enabled, and an authenticated `claude`. The
  probe checks each and skips with a printed reason, so the suite is inert
  rather than red on a machine that cannot host it.
- **Enforcement.** The harness's `~/.claude.json` transforms — the part that
  mutates a shared user file — are pure functions unit-tested in
  [`harness.test.ts`](/plugins/claudemux/test/integration/harness.test.ts),
  which `npm test` and CI do run. The live suite itself is the regression net
  for the hot-path verbs the conformance harness cannot reach.

## References

- [domains/node-cli-orchestrator.md](/.agents/domains/node-cli-orchestrator.md) — the migration roadmap; the hot-path verbs are stage 3, gated on this harness.
- [components/claudemux-core.md](/.agents/components/claudemux-core.md) — the `core/` package and its two test surfaces (conformance and live-teammate).
- [decision node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md) — the Node-CLI pivot whose stage-3 verb migration this harness exists to gate.
- [`core/test/integration/README.md`](/plugins/claudemux/test/integration/README.md) — how to run the suite and its prerequisites.
