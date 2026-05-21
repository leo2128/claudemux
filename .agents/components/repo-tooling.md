# Component: repo tooling

The repo-level scripts, hooks, and CI that keep the codebase consistent.
None of these is shipped inside a plugin — they govern *this repository's*
workflow.

## Files

| Path | Role |
|---|---|
| [`/bin/changeset`](/bin/changeset) | Record one pending change as a changeset fragment — `bin/changeset <plugin> <patch\|minor\|major> "<summary>"` |
| [`/bin/release`](/bin/release) | Consume a plugin's changeset fragments into one version bump and a CHANGELOG entry — `bin/release <plugin>` |
| [`/bin/check-author`](/bin/check-author) | Validate one git author email — the single source of truth for the author rule |
| [`/bin/test-tm-mem`](/bin/test-tm-mem), `/bin/test-tm-prompt-splat` | Standalone `tm` behavior test runners |
| [`/.githooks/pre-commit`](/.githooks/pre-commit) | Two ordered checks: author email, then changeset presence |
| [`/.github/workflows/ci.yml`](/.github/workflows/ci.yml) | CI — shellcheck + bats on an Ubuntu/macOS matrix |
| [`/tests/`](/tests) | bats tests — `pure/` (`tm` functions), `help/` (`tm` snapshots), `cli/` (the changeset/release tooling), fixtures |

## Versioning — the changeset / release model

This repo ships more than one plugin under `plugins/`. Each has its own
manifest (`plugins/<name>/.claude-plugin/plugin.json`) and its own version;
the plugins are versioned independently.

A feature commit never edits the `version` field. It declares its change with
a **changeset fragment** instead:

1. `bin/changeset <plugin> <patch|minor|major> "<one-line summary>"` writes a
   uniquely-named fragment under `plugins/<plugin>/.changeset/`. Commit the
   fragment alongside the change.
2. At release time, `bin/release <plugin>` consumes every pending fragment for
   that plugin: it bumps the manifest `version` by the highest level among
   them, prepends a dated section to `plugins/<plugin>/CHANGELOG.md`, and
   deletes the consumed fragments. `bin/release` is the sole writer of the
   `version` field.

Each feature commit therefore adds a *new, uniquely-named* file rather than
editing the one shared `version` line — so two parallel branches never
collide over versioning. The `version` line moves only in release commits,
which are cut one plugin at a time. The per-change semver intent is not lost:
the fragment records it, and `bin/release` aggregates it (`major` > `minor` >
`patch`) and writes it into the CHANGELOG. See
[decision 0014](/.agents/decisions/0014-changeset-release-versioning.md).

`patch` = bug fix, no visible behavior change; `minor` = new
backward-compatible feature; `major` = breaking change to a documented
contract (a CLI flag, a file path, an on-disk format).

What counts as feature-class is per-plugin, because the plugins differ in
shape:

- `claudemux` (Bash) — `bin/`, `hooks/`, `scripts/`, `templates/`, and any
  `skills/*/SKILL.md`.
- `feishu-channel` (TypeScript) — `src/`, `.mcp.json`, `package.json`, and
  any `skills/*/SKILL.md`.

Pure-docs commits (README, `CLAUDE.md`, KB files, any `*.md` that is not a
`SKILL.md`), CI/test changes, and manifest description/keyword edits are
**exempt**. The `.agents/` KB is not a feature-class path — KB changes never
need a changeset.

## The pre-commit hook

[`/.githooks/pre-commit`](/.githooks/pre-commit) runs two checks:

1. **Author email** — delegates to `bin/check-author` (see below).
2. **Changeset** — for each plugin with a staged feature-class file, the
   commit is rejected unless a changeset fragment for that plugin
   (`plugins/<plugin>/.changeset/<name>.md`) is also staged. Plugins are
   checked independently, and the exact `bin/changeset` command is printed to
   stderr. The per-plugin feature-class globs live in the hook's
   `feature_class_globs` function — a new plugin is onboarded by adding one
   case branch there.

It is a workflow nudge, not a wall: `git commit --no-verify` bypasses it.
Enable it once per clone: `git config core.hooksPath .githooks`.

## The author-email rule

`bin/check-author` is the **one** definition of a valid author email,
shared by two callers: the `pre-commit` hook checks the identity the next
commit *would* use; `ci.yml` checks every commit a push or PR introduces. It
rejects an unparseable address or an mDNS/LAN suffix (`.local`,
`.localdomain`, `.lan`, `.home`, `.internal`) — the shape git fabricates as
`whoami@hostname` when `user.email` is unset. Any valid public email
passes; there is no per-person allowlist. See
[decision 0003](/.agents/decisions/0003-tm-quality-hardening.md).

To stop machine-default identities at the root, set once per machine:
`git config --global user.useConfigOnly true`.

## CI

`ci.yml` runs on every push to `main` and every pull request. It has two
jobs:

- **`check`** — the claudemux plugin, on an `ubuntu-latest` +
  `macos-latest` matrix (`fail-fast: false`). Steps: commit author check →
  install `tmux`/`bats`/`shellcheck` → `shellcheck` on `tm`, the hooks, the
  scripts, `bin/changeset`, `bin/release`, `bin/check-author`, and
  `.githooks/pre-commit` → `bats tests/pure/` → `bats tests/help/` →
  `bats tests/cli/` (the changeset/release tooling).
  The matrix is what makes the cross-platform invariant enforceable rather
  than aspirational.
- **`feishu-channel`** — the `feishu-channel` plugin, on `ubuntu-latest`
  only. It installs Bun and runs the plugin's `bun test` suite and
  type-check. That suite is OS-agnostic TypeScript, so one OS is enough; it
  is a separate job so the Bun toolchain stays off the bats lane. A final
  step runs `test/feishu-live.ts` against the real Feishu platform, using the
  `FEISHU_APP_ID` / `FEISHU_APP_SECRET` repository secrets; that test skips
  itself when the secrets are absent.

The `feishu-channel` job covers a plugin that is still on a branch — see
[components/feishu-channel.md](/.agents/components/feishu-channel.md).

## See also

- [decisions/0003-tm-quality-hardening.md](/.agents/decisions/0003-tm-quality-hardening.md) — how CI, tests, and the lint hooks were introduced.
- [decisions/0014-changeset-release-versioning.md](/.agents/decisions/0014-changeset-release-versioning.md) — why versioning moved to changeset fragments and a release step.
- [components/tm.md](/.agents/components/tm.md) — what shellcheck and the bats suite guard.
