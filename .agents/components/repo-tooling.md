# Component: repo tooling

The repo-level scripts, hooks, and CI that keep the codebase consistent.
None of these is shipped inside a plugin — they govern *this repository's*
workflow.

## Files

| Path | Role |
|---|---|
| [`/bin/check-author`](/bin/check-author) | Validate one git author email — the single source of truth for the author rule |
| [`/bin/test-tm-mem`](/bin/test-tm-mem), `/bin/test-tm-prompt-splat` | Standalone `tm` behavior test runners |
| [`/plugins/claudemux/package.json`](/plugins/claudemux/package.json) | Official Changesets package manifest for claudemux release automation |
| [`/plugins/claudemux/.changeset/config.json`](/plugins/claudemux/.changeset/config.json) | Changesets config: `next` base branch, private package versioning, and claudemux release-surface globs |
| [`/plugins/claudemux/scripts/sync-plugin-version.mjs`](/plugins/claudemux/scripts/sync-plugin-version.mjs) | Mirror `package.json.version` into `.claude-plugin/plugin.json.version` after Changesets versions packages |
| [`/.githooks/pre-commit`](/.githooks/pre-commit) | Local author-email check |
| [`/.github/workflows/ci.yml`](/.github/workflows/ci.yml) | CI — shellcheck + bats on an Ubuntu/macOS matrix |
| [`/tests/`](/tests) | bats tests — `cli/` covers repo tooling and hook regressions; TypeScript core conformance lives under `plugins/claudemux/core/test/` |

## Versioning — official Changesets

Claudemux is versioned with official Changesets, scoped to
`plugins/claudemux/`. The Claude Code plugin manifest remains
`plugins/claudemux/.claude-plugin/plugin.json`, but Changesets reads and writes
`plugins/claudemux/package.json`.

A feature commit never edits either version field. It declares release intent
with an official Changesets fragment:

```bash
pnpm --dir plugins/claudemux changeset
```

Commit the generated `plugins/claudemux/.changeset/*.md` file alongside the
change. Release automation later runs `pnpm --dir plugins/claudemux
version-packages`, which calls `changeset version` and then mirrors the
resulting package version into `.claude-plugin/plugin.json`.

Each feature commit therefore adds a new fragment rather than editing the
shared `version` line, so two parallel branches do not collide over versioning.
The per-change semver intent is not lost: the fragment records it, and
Changesets aggregates it (`major` > `minor` > `patch`) and writes it into the
generated changelog. See
[decision changeset-release-versioning](/.agents/decisions/changeset-release-versioning.md).

`patch` = bug fix, no visible behavior change; `minor` = new
backward-compatible feature; `major` = breaking change to a documented
contract (a CLI flag, a file path, an on-disk format).

What counts as feature-class is per-plugin, because the plugins differ in
shape. Claudemux's release surface is declared in
`plugins/claudemux/.changeset/config.json`:

- `claudemux` (Bash) — `bin/`, `hooks/`, `scripts/`, `templates/`, and any
  `skills/*/SKILL.md`; plus `core/src/*`, `core/package.json`,
  `core/resolver.mjs`, `core/resolver-register.mjs`, and
  `core/third_party/*`.
- `feishu-channel` (TypeScript) — `src/`, `.mcp.json`, `package.json`, and
  any `skills/*/SKILL.md`.

Pure-docs commits (README, `CLAUDE.md`, KB files, any `*.md` that is not a
`SKILL.md`), CI/test changes, and manifest description/keyword edits are
**exempt**. The `.agents/` KB is not a feature-class path — KB changes never
need a changeset.

## The pre-commit hook

[`/.githooks/pre-commit`](/.githooks/pre-commit) delegates the author-email
rule to `bin/check-author`. Changeset enforcement belongs to CI, not to the
local hook. Enable the hook once per clone:
`git config core.hooksPath .githooks`.

## The author-email rule

`bin/check-author` is the **one** definition of a valid author email,
shared by two callers: the `pre-commit` hook checks the identity the next
commit *would* use; `ci.yml` checks every commit a push or PR introduces. It
rejects an unparseable address or an mDNS/LAN suffix (`.local`,
`.localdomain`, `.lan`, `.home`, `.internal`) — the shape git fabricates as
`whoami@hostname` when `user.email` is unset. Any valid public email
passes; there is no per-person allowlist. See
[decision tm-quality-hardening](/.agents/decisions/tm-quality-hardening.md).

To stop machine-default identities at the root, set once per machine:
`git config --global user.useConfigOnly true`.

## CI

`ci.yml` runs on every push to `main` and every pull request. It has two
jobs:

- **`check`** — the claudemux plugin, on an `ubuntu-latest` +
  `macos-latest` matrix (`fail-fast: false`). Steps: commit author check →
  install `tmux`/`bats`/`shellcheck`/`jq` → `shellcheck` on `tm`, the hooks,
  the scripts, `bin/check-author`, and `.githooks/pre-commit` →
  `bats tests/cli/` (repo-tooling and hook regression tests).
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

- [decisions/tm-quality-hardening.md](/.agents/decisions/tm-quality-hardening.md) — how CI, tests, and the lint hooks were introduced.
- [decisions/changeset-release-versioning.md](/.agents/decisions/changeset-release-versioning.md) — why versioning moved to Changesets fragments and release PRs.
- [components/tm.md](/.agents/components/tm.md) — what shellcheck and the bats suite guard.
