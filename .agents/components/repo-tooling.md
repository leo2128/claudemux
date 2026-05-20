# Component: repo tooling

The repo-level scripts, hooks, and CI that keep the codebase consistent.
None of these is shipped inside a plugin — they govern *this repository's*
workflow.

## Files

| Path | Role |
|---|---|
| [`/bin/bump-version`](/bin/bump-version) | Bump the `version` field in the claudemux `plugin.json` (`patch`/`minor`/`major`) |
| [`/bin/check-author`](/bin/check-author) | Validate one git author email — the single source of truth for the author rule |
| [`/bin/test-tm-mem`](/bin/test-tm-mem), `/bin/test-tm-prompt-splat` | Standalone `tm` behavior test runners |
| [`/.githooks/pre-commit`](/.githooks/pre-commit) | Two ordered checks: author email, then version bump |
| [`/.github/workflows/ci.yml`](/.github/workflows/ci.yml) | CI — shellcheck + bats on an Ubuntu/macOS matrix |
| [`/tests/`](/tests) | bats tests for `tm` (`pure/` functions, `help/` snapshots, fixtures) |

## Versioning

The plugin version lives in
[`/plugins/claudemux/.claude-plugin/plugin.json`](/plugins/claudemux/.claude-plugin/plugin.json).
Bump it with `bin/bump-version <patch|minor|major>` whenever you ship a
change to a **feature-class path**:

- `bin/`, `hooks/`, `scripts/`, `templates/` under `plugins/claudemux/`
- any `skills/*/SKILL.md`

`patch` = bug fix, no visible behavior change; `minor` = new
backward-compatible feature; `major` = breaking change to a documented
contract (a CLI flag, a file path, an on-disk format).

Pure-docs commits (README, `CLAUDE.md`, KB files, any `*.md` that is not a
`SKILL.md`), CI/test changes, and `plugin.json` description/keyword edits
are **exempt**. The `.agents/` KB is not a feature-class path — KB changes
never need a version bump.

## The pre-commit hook

[`/.githooks/pre-commit`](/.githooks/pre-commit) runs two checks:

1. **Author email** — delegates to `bin/check-author` (see below).
2. **Version bump** — if any staged file is feature-class and `plugin.json`'s
   `version` field did not change in the same commit, the commit is
   rejected, with the exact `bin/bump-version` command printed to stderr.

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

`ci.yml` runs on every push to `main` and every pull request, on an
`ubuntu-latest` + `macos-latest` matrix (`fail-fast: false`). Steps: commit
author check → install `tmux`/`bats`/`shellcheck` → `shellcheck` on `tm`,
the hooks, the scripts, and `bin/bump-version` → `bats tests/pure/` → `bats
tests/help/`. The matrix is what makes the cross-platform invariant
enforceable rather than aspirational.

CI currently covers the **claudemux** plugin only. The `feishu-channel`
plugin's `bun test` suite is not yet wired in — see
[components/feishu-channel.md](/.agents/components/feishu-channel.md).

## See also

- [decisions/0003-tm-quality-hardening.md](/.agents/decisions/0003-tm-quality-hardening.md) — how CI, tests, and the lint hooks were introduced.
- [components/tm.md](/.agents/components/tm.md) — what shellcheck and the bats suite guard.
