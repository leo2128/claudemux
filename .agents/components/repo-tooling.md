# Component: repo tooling

The repo-level scripts, hooks, and CI that keep the codebase consistent.
None of these is shipped inside a plugin — they govern *this repository's*
workflow.

## Files

| Path | Role |
|---|---|
| [`/bin/bump-version`](/bin/bump-version) | Bump the `version` field in a plugin's manifest — `bin/bump-version <plugin> <patch\|minor\|major>` |
| [`/bin/check-author`](/bin/check-author) | Validate one git author email — the single source of truth for the author rule |
| [`/bin/test-tm-mem`](/bin/test-tm-mem), `/bin/test-tm-prompt-splat` | Standalone `tm` behavior test runners |
| [`/.githooks/pre-commit`](/.githooks/pre-commit) | Two ordered checks: author email, then version bump |
| [`/.github/workflows/ci.yml`](/.github/workflows/ci.yml) | CI — shellcheck + bats on an Ubuntu/macOS matrix |
| [`/tests/`](/tests) | bats tests for `tm` (`pure/` functions, `help/` snapshots, fixtures) |

## Versioning

This repo ships more than one plugin under `plugins/`. Each has its own
manifest (`plugins/<name>/.claude-plugin/plugin.json`) and its own version;
the plugins are versioned independently. Bump one with
`bin/bump-version <plugin> <patch|minor|major>` whenever you ship a change to
that plugin's **feature-class paths**.

What counts as feature-class is per-plugin, because the plugins differ in
shape:

- `claudemux` (Bash) — `bin/`, `hooks/`, `scripts/`, `templates/`, and any
  `skills/*/SKILL.md`.
- `feishu-channel` (TypeScript) — `src/`, `.mcp.json`, `package.json`, and
  any `skills/*/SKILL.md`.

`patch` = bug fix, no visible behavior change; `minor` = new
backward-compatible feature; `major` = breaking change to a documented
contract (a CLI flag, a file path, an on-disk format).

Pure-docs commits (README, `CLAUDE.md`, KB files, any `*.md` that is not a
`SKILL.md`), CI/test changes, and manifest description/keyword edits are
**exempt**. The `.agents/` KB is not a feature-class path — KB changes never
need a version bump.

## The pre-commit hook

[`/.githooks/pre-commit`](/.githooks/pre-commit) runs two checks:

1. **Author email** — delegates to `bin/check-author` (see below).
2. **Version bump** — for each plugin with a staged feature-class file, the
   commit is rejected unless that plugin's manifest `version` field changed
   in the same commit. Plugins are checked independently, and the exact
   `bin/bump-version` command is printed to stderr. The per-plugin
   feature-class globs live in the hook's `feature_class_globs` function — a
   new plugin is onboarded by adding one case branch there.

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
  scripts, `bin/bump-version`, `bin/check-author`, and `.githooks/pre-commit`
  → `bats tests/pure/` → `bats tests/help/`.
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
- [components/tm.md](/.agents/components/tm.md) — what shellcheck and the bats suite guard.
