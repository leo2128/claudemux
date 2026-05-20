# 0003 — `tm` quality hardening

- **Status:** Accepted
- **Date:** 2026-05-19 – 2026-05-20
- **Affects:** `tm`, the hooks, repo tooling, CI

## Context

`tm` had grown to a ~2000-line Bash script with no automated tests, no lint
gate, and no CI. It ran on macOS only — by accident, not by design: it used
BSD-only commands that would degrade silently on Linux. Several latent bugs
were of the kind that only structure can catch: a project-dir encoding
reproduced by hand in more than one place, protocol paths concatenated as
raw strings, `bash`-3.2 incompatibilities. A burst of commits over two days
hardened the whole surface.

## Decision

Treat `tm` and the hooks as production code and put guardrails under them.

- **CI matrix.** A GitHub Actions workflow runs on `ubuntu-latest` *and*
  `macos-latest` (`fail-fast: false`). Running on both OSes is what turns
  the cross-platform rule from aspiration into an enforced check.
- **shellcheck.** CI shellchecks `tm`, the hook scripts, the plugin
  scripts, and `bin/bump-version`. The script was cleaned to pass.
- **bats tests.** Two suites: `tests/pure/` covers pure helper functions
  (`session_name`, `sid_file`, `fmt_age`, …); `tests/help/` snapshots the
  output of `tm help <verb>` so a verb contract cannot drift unnoticed.
- **Cross-platform `stat` helpers.** BSD vs GNU `stat` flags are mutually
  exclusive; the flavor is detected once and dispatched through
  `stat_size` / `stat_mtime` helpers, in both `tm` and `on-stop.sh`.
- **One project-dir encoder.** The cwd→`~/.claude/projects/<encoded>` map
  is centralized in `encode_project_dir`. A prior hand-rolled `tr / -` site
  had dropped the dot-to-dash part of the encoding and broken `tm resume`;
  the single encoder fixed `cmd_resume` and let `cmd_mem` reuse it.
- **Named path builders for the idle-dir protocol.** Every
  `/tmp/claude-idle/<sid>.*` path is built by `idle_marker_for` /
  `busy_marker_for` / `last_file_for`, mirrored inline in the hooks.
- **Commit-author lint.** `bin/check-author` is the single definition of a
  valid author email, shared by the `pre-commit` hook (checks the next
  commit's identity) and CI (checks every commit a push or PR introduces).
  It rejects unparseable addresses and mDNS/LAN suffixes — the
  `whoami@hostname` shape git invents when `user.email` is unset.

## Consequences

- A cross-platform regression now fails CI on the Linux leg instead of
  degrading silently in the field.
- A verb's `--help` contract is snapshot-tested — changing it without
  updating the snapshot fails CI, which keeps `tm --help` trustworthy as
  the single source of truth.
- The recurring drift patterns were abstracted into three durable rules and
  promoted into the repo `CLAUDE.md` — recorded separately in
  [decision 0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md).
- CI covers the **claudemux** plugin only; the `feishu-channel` plugin's
  `bun test` suite is not yet wired in.

## References

- Commits `c2bed03` (CI workflow), `2fdc987` (bats pure-function tests),
  `872c00d` (help-snapshot tests), `1a0d870` / `139ad83` (shellcheck +
  macOS tmux), `a33fe8d` (0.5.6 — cross-platform `stat` helpers), `c2075b7`
  (0.5.5 — single project-dir encoder), `13724c0` (0.6.0 — idle-dir path
  builders), `6c3a035` (author check in pre-commit), `3ac230d` (relax the
  author check to format + machine-identity blacklist), `46b5151` (enforce
  the author check in CI via `bin/check-author`).
- [components/repo-tooling.md](/.agents/components/repo-tooling.md),
  [components/tm.md](/.agents/components/tm.md).
