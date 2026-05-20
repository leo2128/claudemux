# 0004 — Cross-process & cross-platform invariants in `CLAUDE.md`

- **Status:** Accepted
- **Date:** 2026-05-19
- **Affects:** `CLAUDE.md`, `tm`, the hooks

## Context

The hardening work in [decision 0003](/.agents/decisions/0003-tm-quality-hardening.md)
fixed specific bugs. But three of those bugs were not one-off mistakes —
they were the *same class* of mistake recurring, and each had already
drifted at least once before being caught. A fixed bug stays fixed; a
drift-prone pattern re-drifts on the next edit unless the rule is written
down where every future agent will see it.

So three rules were promoted into the always-loaded repo `CLAUDE.md`, under
"Cross-Process & Cross-Platform Invariants" — each stated next to the
concrete drift that justified it, so the rule can be applied to new edge
cases and not just pattern-matched.

## Decision

Record three invariants in `CLAUDE.md`, each with its origin.

1. **Path-builder discipline.** Every `/tmp/teammate-*`,
   `/tmp/claude-idle/*`, and `~/.claude/projects/<encoded>/...` path is
   built by a named builder function — no raw string concatenation at use
   sites. *Origin:* the `/tmp` protocol is the coupling layer between `tm`
   and the hooks; spreading its shape across many string literals makes the
   next schema change a non-atomic sweep across files (`tm` and the hooks
   cannot be refactored together — hooks cannot `source` `tm`). The
   discipline is "a named function at every site", not "one shared
   definition".

2. **Cross-platform shell discipline.** Every command whose flags differ
   between BSD (macOS) and GNU (Linux) — `stat -f`/`-c`, `sed -i`, GNU-only
   `find -printf` / `date -d` / `readlink -f`, `tail -r`/`tac` — goes
   through an OS-detected helper, or the script declares itself macOS-only
   at the top. *Origin:* CI runs on both OSes; a BSD-only command paired
   with `|| echo 0` degrades silently on Linux instead of failing — harder
   to catch than a hard error.

3. **One source of truth for the project-dir encoding.** Any code mapping a
   teammate cwd → Claude Code's project-dir name routes through
   `encode_project_dir` (and its `project_dir_for_repo` wrapper). *Origin:*
   the encoding — `/` and `.` both → `-` — is an Anthropic-controlled
   contract; reproducing it by hand guarantees one site drifts. It already
   happened: a `tr / -` site silently dropped the dots.

## Consequences

- `CLAUDE.md` is always loaded, so every agent editing `tm` or the hooks
  sees these rules before touching the coupling layer.
- The rules are stated as positive actions with their reason, per the repo
  convention for agent instructions — not as bare prohibitions.
- Where a rule can be machine-enforced it is: the cross-platform rule is
  backed by the CI OS matrix; the encoding rule is backed by the single
  `encode_project_dir` function. The `CLAUDE.md` text explains the rules
  the structure already enforces.
- A future agent must keep this record, `CLAUDE.md`, and
  [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md)
  consistent. `CLAUDE.md` is authoritative if they diverge.

## References

- Commit `be884f0` (0.5.7 — `CLAUDE.md` cross-process / cross-platform
  invariants + `on-stop.sh` rewrite).
- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md),
  [decisions/0003-tm-quality-hardening.md](/.agents/decisions/0003-tm-quality-hardening.md).
