# 0014 — Versioning moves to changeset fragments consumed by a release step

- **Status:** Accepted
- **Date:** 2026-05-21
- **Affects:** repo tooling — `.githooks/pre-commit`, `bin/`, `CLAUDE.md`,
  `.github/workflows/ci.yml`

## Context

The previous rule: every commit that touched a plugin's feature-class path had
to bump that plugin's `plugin.json` `version` field **in the same commit**,
enforced by `.githooks/pre-commit`. `bin/bump-version` performed the edit.

That rule made every feature PR mutate one specific line — `"version": "..."` —
in `plugin.json`. Two feature PRs branched off the same `main` both edit that
line to the same next value. Whichever merges first wins; the second now
conflicts on that line and must rebase and re-bump. This is not a tooling bug
that can be patched away — it is structural. **Any scheme in which every PR
mutates one shared scalar guarantees a conflict between any two concurrent
PRs.** The conflict rate scales with parallelism, and the project runs several
plugin PRs in parallel.

The fix has to remove "every PR edits the version line" without losing what
the version line bought: a per-change semantic-version judgement
(patch/minor/major) made by the author who knows whether a change is
breaking, and a way to tell which changes a released version contains.

## Decision

Adopt a **changeset / release** model — the news-fragment pattern
(`changesets`, `towncrier`), adapted to this repo's multi-plugin layout.

### A feature commit adds a changeset fragment, not a version bump

`bin/changeset <plugin> <patch|minor|major> "<summary>"` writes a fragment to
`plugins/<plugin>/.changeset/<unique-name>.md` — line 1 is the level, the rest
is a one-line summary. The name is a UTC timestamp plus a random suffix, so
**every invocation writes a different path**. Two concurrent branches add two
different new files; git merges both with no conflict. There is no shared line
to contend on.

### A release consumes the fragments

`bin/release <plugin>` reads every pending fragment for the plugin, bumps the
manifest `version` by the **highest** level among them
(`major` > `minor` > `patch`), prepends a dated section to
`plugins/<plugin>/CHANGELOG.md` listing each change, and deletes the consumed
fragments. `bin/release` is the *only* command that edits a `version` field.
Release commits for one plugin are cut one at a time, so they do not collide
with each other either.

### The pre-commit hook enforces a changeset, not a bump

`.githooks/pre-commit` still rejects a staged feature-class file with no
accompanying versioning artifact — but the artifact is now a staged changeset
fragment for that plugin, not a changed `version` field. The per-PR nudge
("you changed runtime behavior — classify it") is preserved; only the artifact
changed from a conflict-prone line edit to a conflict-free new file.

### `bin/bump-version` is removed

Its role splits cleanly into `bin/changeset` (declare) and `bin/release`
(apply). Keeping a third script that bumps the line directly would reopen the
exact hazard this decision closes.

## Why this keeps the version ↔ change mapping

This was the load-bearing constraint, and the model strengthens it rather than
weakening it:

- The semver **level** is still chosen per change, by the PR author, at PR
  time — recorded in the fragment. `bin/release` aggregates it mechanically.
  It is never re-guessed later by a release author reading `git log`.
- `CHANGELOG.md` becomes the durable, user-facing record: each released
  version carries the list of changes that went into it, with their levels.
  The old model had no changelog at all — "what is in 0.6.0?" was answerable
  only by blaming the `version` line and reading commits around it.

## Alternatives considered

- **Omit the `version` field entirely.** The manifest `version` is optional;
  without it a plugin still loads. This removes the conflict but discards the
  user-visible version and all semver signalling — an installed user could not
  tell a breaking release from a patch. Rejected: it solves the conflict by
  deleting the thing of value.
- **Defer the bump to release with no per-change record** — feature PRs touch
  nothing, and a release author decides the level from `git log`. Simpler, but
  the breaking-vs-not judgement moves from the person who made the change to
  someone reconstructing it later, and the per-PR nudge disappears entirely.
  Rejected: it loses fidelity precisely where fidelity matters.

## Consequences

- A plugin gains a `.changeset/` directory, usually empty. Between a feature
  merge and the next release, `main` carries a few small fragment files;
  installing the plugin from `main` mid-cycle pulls that minor cruft. This is
  the same trade the `changesets` tool makes and is accepted.
- The version no longer increments per commit. Between releases, `main`'s
  `plugin.json` `version` lags the code; the pending `.changeset/` fragments
  *are* the unreleased delta. Cutting a release is now an explicit step.
- `CHANGELOG.md` files start at the first release under this model. Versions
  released before it remain recoverable from git history; they are not
  back-filled.
- CI updates: `shellcheck` now lints `bin/changeset` and `bin/release`; a
  `bats tests/cli/` step covers the two scripts end to end.
- Decision [0003](/.agents/decisions/0003-tm-quality-hardening.md) introduced
  `bin/bump-version`; that script is retired here. The lint/test/hook
  machinery 0003 established otherwise stands.
- A PR already open against the old rule still carries a `version` bump in its
  diff. To stop conflicting it should drop that bump and add a changeset with
  `bin/changeset` instead; `bin/release` will apply the bump at release time.

## References

- `bin/changeset`, `bin/release` — the two scripts.
- `.githooks/pre-commit` — the changeset check.
- `CLAUDE.md` → "Versioning"; [components/repo-tooling.md](/.agents/components/repo-tooling.md).
- `tests/cli/changeset_release.bats` — the regression suite.
