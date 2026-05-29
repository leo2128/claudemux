# Versioning uses official Changesets fragments with direct-push automation

- **Status:** Accepted
- **Date:** 2026-05-21
- **Amended:** 2026-05-29
- **Affects:** repo tooling — `/.changeset/`,
  `plugins/claudemux/package.json`, `.github/workflows/ci.yml`,
  `.husky/pre-commit`, `CLAUDE.md`

## Context

The first version of this decision moved the repo away from "every feature PR
edits the plugin manifest version line" because that model made parallel
feature branches conflict on the same scalar. It introduced a local
changeset/release pair to record per-change semver intent and apply it later.

The conflict analysis still stands, but local release tooling is not the right
long-term owner for fragment parsing, semver arithmetic, changelog writing, or
pre-release channels. Those mechanisms are mature in the official Changesets
toolchain.

## Decision

Use official Changesets for claudemux release intent and versioning.

Claudemux is a plugin, not an npm-published package, so the Changesets package
manifest lives at `plugins/claudemux/package.json`. The Claude Code runtime
manifest remains `plugins/claudemux/.claude-plugin/plugin.json`; after
`changeset version` updates `package.json`, the `version-packages` script
mirrors the version into `.claude-plugin/plugin.json`.

### Feature commits add official Changesets fragments

Authors record claudemux release intent by writing a fragment directly to
`/.changeset/<slug>.md` — do not use the interactive CLI. The fragment
records the package, semver level, and release note text. The feature commit
carries that fragment instead of editing a version field.

### Release automation consumes fragments by direct push

Merging into a trunk runs `changeset version` and pushes the result back to
that branch as the release bot — no intermediate "Version Packages" PR.

- `next` (`claudemux-release-next.yml`, on push): runs
  `pnpm --dir plugins/claudemux version-packages`, which calls `changeset
  version` and then mirrors the resulting package version into the Claude
  plugin manifest, commits `chore(release): claudemux beta`, and pushes to
  `next`. It is a no-op when the push added no new `.changeset/*.md`.
- `main` (`claudemux-release-main.yml`, on push): runs
  `pnpm --dir plugins/claudemux version-ga` (`changeset pre exit && changeset
  version && sync`), commits the GA version, and pushes to `main`.

The bot push runs with `HUSKY=0`, because the local pre-push changeset hook
(below) misfires on a release commit: the bump touches a release-surface file
(`package.json`) whose changeset is already consumed.

### `next` is the beta channel; `main` is GA

`/.changeset/pre.json` keeps claudemux in Changesets pre mode on `next`, tag
`beta`, so merges to `next` produce `-beta.N` versions. In pre mode `changeset
version` records consumed fragments in `pre.json` and retains the `.md` files;
they accumulate until GA.

GA is bound to the `next → main` merge. `release-main` runs only when the
merged state still carries `pre.json` mode `pre`; `changeset pre exit`
consumes the accumulated fragments into the stable version, deletes the
fragments, and deletes `pre.json` — so the bot's own GA commit re-triggers the
workflow with no pre.json and the guard exits. After a successful GA,
`claudemux-reset-next-pre.yml` fast-forwards `next` to main's GA state and
re-enters beta pre mode, so the next prerelease cycle versions from the GA base
rather than re-consuming shipped changesets.

### Changeset enforcement is CI-owned

The authoritative gate is the CI `claudemux-changeset-status` job on every PR
into `next`: a PR that touches a release surface without a changeset fails.
The local `.husky/pre-push` hook runs the same check as best-effort fast
feedback, but it is advisory — it does not fire in a fresh clone or worktree
that has not run `pnpm install`, and it is disabled (`HUSKY=0`) in the release
jobs. The release surface for claudemux is declared in
`/.changeset/config.json` with `changedFilePatterns`.

## Why this keeps the version ↔ change mapping

- The semver level is still chosen per change, by the PR author, at PR time.
- The version line moves only in the bot's release commit, so parallel feature
  branches do not collide on it.
- The changelog is generated from the fragments that were actually consumed by
  the release commit.
- Pre-release and GA suffix handling come from Changesets pre mode rather than
  custom semver code.

## Alternatives considered

- **Keep local release scripts.** Rejected: fragment parsing, changelog
  writing, beta suffixes, and release automation are already solved by
  a mature toolchain.
- **Commit-message-driven release tools.** Rejected for claudemux because the
  desired author workflow is an explicit changeset fragment, not Conventional
  Commit inference.
- **Omit the version field entirely.** Rejected: installed users and release
  notes still need a visible semver.
- **Defer release level with no per-change record.** Rejected: it moves the
  breaking-vs-non-breaking judgment away from the author and into release-time
  archaeology.

## Consequences

- `/.changeset/` is now a standard Changesets directory at the workspace
  root, covering both `claudemux` and `claude-channel-feishu`.
- `plugins/claudemux/package.json` is the Changesets source for claudemux
  versioning; `.claude-plugin/plugin.json` is mirrored from it.
- `plugins/claudemux/CHANGELOG.md` is generated by Changesets and starts over
  under the official format. Earlier history remains in git.
- The local pre-commit hook no longer enforces changeset presence. CI owns
  that check.

## References

- `plugins/claudemux/package.json`
- `/.changeset/config.json`
- `plugins/claudemux/scripts/sync-plugin-version.mjs`
- `CLAUDE.md` → "Versioning"; [components/repo-tooling.md](/.agents/components/repo-tooling.md)
