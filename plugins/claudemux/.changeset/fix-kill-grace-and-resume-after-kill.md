---
"claudemux": patch
---

Fix two beta.10 worktree-mode regressions:

- `tm kill` now treats the teammate's idle marker
  (`/tmp/claude-idle/<sid>`) being touched as a positive SessionEnd
  signal — on-stop.sh fires SessionEnd before tmux reaps the pane, so
  the kill returns graceful as soon as the marker advances instead of
  paying the full process-teardown wall-clock. The combined budget is
  bumped 8s → 20s (15s exit + 5s keep) so a slow Opus 4.7 box on
  Linux no longer SIGHUPs every clean kill and leaks
  `claude --worktree` worktrees. Override via `CLAUDEMUX_KILL_GRACE_MS`.

- `tm kill` now archives the live identity record before deleting it.
  `tm resume <name> <sid>` and `tm history <name>` consult the
  archive when the live record is gone, so they recover the killed
  teammate's worktree cwd / repo / worktreeSlug instead of falling
  back to the dispatcher's directory. The agent never has to read or
  write under `/tmp` directly — the standard verbs cover the
  post-kill recovery path.
