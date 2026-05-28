# claudemux

## 1.0.0-beta.17

### Patch Changes

- cebbfa7: sync-plugin-version now mirrors the feishu-channel plugin manifest version as well, so `plugins/feishu-channel/.claude-plugin/plugin.json` stays in lockstep with its package.json after `changeset version` instead of drifting.

## 1.0.0-beta.16

### Patch Changes

- 0822262: Fix dispatcher skill docs to match live `tm` CLI: correct `<repo>`/`<name>` confusion (post-spawn verbs take `<name>`; spawn takes `<path>`), fix `tm wait <name> --fresh` flag order in two places, remove the deleted `--task <slug>` spawn flag, and clean up associated historical commentary.

## 1.0.0-beta.15

### Patch Changes

- 05377ec: docs: clarify that the "AutoMemory directory" in the dispatcher template and skill references is `~/.claude/projects/<encoded-cwd>/memory/`, not a project-local path

## 1.0.0-beta.14

### Major Changes

- 7d79110: worktree default + name/repo decoupling (schema 2)

  **Breaking changes — `tm kill` and respawn any live teammate before
  upgrading.** The on-disk identity layout, the spawn CLI shape, and the
  SessionStart env var rename are all incompatible with pre-cut state.

  CLI:

  - `tm spawn <path>` now takes a filesystem path (absolute or
    dispatcher-relative). The teammate name is a flat opaque identifier
    controlled by `--name <id>` (`^[A-Za-z0-9][A-Za-z0-9_-]*$`) or
    auto-generated as `<basename(path)>-<rand4>`.
  - Every other teammate verb (`tm send` / `tm wait` / `tm kill` /
    `tm status` / `tm last` / `tm mem` / `tm resume` / etc.) takes
    the flat `<name>` returned by `tm spawn`. No path coupling.
  - `--task <slug>` is removed; use `--name <id>` instead.
  - `--no-worktree` opts a teammate out of worktree mode.

  Default behaviour:

  - Claude teammates launch with `claude --worktree <name>`, landing in
    `<path>/.claude/worktrees/<name>/` (branch `worktree-<name>`, base
    ref `HEAD`). The settings JSON Claude inherits sets
    `worktree.baseRef: "head"`.
  - Codex teammates use claudemux-managed `git worktree add` at the
    same `<path>/.claude/worktrees/<name>/` layout.
  - `tm kill` sends `/exit` to the REPL, waits 5s for `SessionEnd`
    (Claude auto-removes a clean worktree), then sends `Enter` (default
    "Keep worktree" on the dirty-worktree TUI prompt) and waits 3s
    more, falling back to `tmux kill-session` (SIGHUP) only when
    graceful exit times out. Codex `tm kill` removes a clean worktree
    via `git worktree remove --force`, preserves dirty worktrees with
    a stderr warning.

  On-disk surfaces:

  - Identity schema bumped 1 → 2. New fields: `repo`, `worktreeSlug`.
    Schema 1 records are rejected — kill + respawn.
  - `tmux` session name is `teammate-<name>` directly; the `/` → `__`
    encoding (nested-name support) is removed.
  - SessionStart env identity gate is `CLAUDEMUX_TEAMMATE_NAME`
    (previously `CLAUDEMUX_TEAMMATE_REPO`).

  `tm ls` / `tm states` now emit `NAME / REPO / WORKTREE / ENGINE /
STATE` (and the runtime cells for `tm states`).

  `.worktreeinclude` is not yet supported on the Codex self-managed
  path; copy any required gitignored files (`.env`, etc.) into the
  worktree manually for Codex teammates. Claude teammates inherit
  Claude Code's native `.worktreeinclude` handling.

  Research: https://www.feishu.cn/docx/P5fOdzDkFoEisQxRupNcIKsxnJf

### Minor Changes

- 7d79110: add Codex UI IPC bridge for live Desktop and VS Code visibility
- 7d79110: migrate release pipeline to Changesets

### Patch Changes

- 7d79110: fix Codex UI IPC discovery for follower control requests
- 7d79110: fix Codex UI IPC follower interrupt and steering controls
- 7d79110: add next beta release automation workflow
- 7d79110: dispatcher skill: add MUST/MUST-NOT prompt-composition checklist for `tm spawn/send --prompt` and a default-to-parallel dispatch posture for fan-out across teammates
- 7d79110: fix Codex UI IPC live snapshot broadcasts by sending the method schema version
- 7d79110: fix: correct cron host rule — `tm`-spawned Claude tmux sessions can also host CronCreate jobs; only `claude -p` and Agent Teams subagents silently fail to fire
- 7d79110: Fix two beta.10 worktree-mode regressions:

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

- 7d79110: `tm kill`: tear down the tmux session on graceful exit too. The
  idle-marker SessionEnd signal fires while Claude's REPL is still
  unwinding, so the shell that hosted Claude was left holding the
  tmux session alive as a bare prompt — the teammate appeared
  `unknown` in `tm ls` and a subsequent `tm spawn`/`tm resume`
  reported "already running". The graceful branch now issues a
  best-effort `tmux kill-session` after the marker signal, matching
  the SIGHUP-fallback path.
- 7d79110: fix next beta release workflow prerelease changeset consumption
- 7d79110: add promote-main and reset-next-pre release workflows
- 7d79110: switch the next beta release workflow direct push to the claudemux release GitHub App token
- 7d79110: switch next beta release workflow to direct push without GitHub App credentials
- 7d79110: add changeset-status CI gate

## 1.0.0-beta.13

### Patch Changes

- 4d2f0f5: `tm kill`: tear down the tmux session on graceful exit too. The
  idle-marker SessionEnd signal fires while Claude's REPL is still
  unwinding, so the shell that hosted Claude was left holding the
  tmux session alive as a bare prompt — the teammate appeared
  `unknown` in `tm ls` and a subsequent `tm spawn`/`tm resume`
  reported "already running". The graceful branch now issues a
  best-effort `tmux kill-session` after the marker signal, matching
  the SIGHUP-fallback path.

## 1.0.0-beta.12

### Patch Changes

- 0a0b2cd: Fix two beta.10 worktree-mode regressions:

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

## 1.0.0-beta.11

### Patch Changes

- a1f4930: dispatcher skill: add MUST/MUST-NOT prompt-composition checklist for `tm spawn/send --prompt` and a default-to-parallel dispatch posture for fan-out across teammates

## 1.0.0-beta.10

### Major Changes

- 01cd095: worktree default + name/repo decoupling (schema 2)

  **Breaking changes — `tm kill` and respawn any live teammate before
  upgrading.** The on-disk identity layout, the spawn CLI shape, and the
  SessionStart env var rename are all incompatible with pre-cut state.

  CLI:

  - `tm spawn <path>` now takes a filesystem path (absolute or
    dispatcher-relative). The teammate name is a flat opaque identifier
    controlled by `--name <id>` (`^[A-Za-z0-9][A-Za-z0-9_-]*$`) or
    auto-generated as `<basename(path)>-<rand4>`.
  - Every other teammate verb (`tm send` / `tm wait` / `tm kill` /
    `tm status` / `tm last` / `tm mem` / `tm resume` / etc.) takes
    the flat `<name>` returned by `tm spawn`. No path coupling.
  - `--task <slug>` is removed; use `--name <id>` instead.
  - `--no-worktree` opts a teammate out of worktree mode.

  Default behaviour:

  - Claude teammates launch with `claude --worktree <name>`, landing in
    `<path>/.claude/worktrees/<name>/` (branch `worktree-<name>`, base
    ref `HEAD`). The settings JSON Claude inherits sets
    `worktree.baseRef: "head"`.
  - Codex teammates use claudemux-managed `git worktree add` at the
    same `<path>/.claude/worktrees/<name>/` layout.
  - `tm kill` sends `/exit` to the REPL, waits 5s for `SessionEnd`
    (Claude auto-removes a clean worktree), then sends `Enter` (default
    "Keep worktree" on the dirty-worktree TUI prompt) and waits 3s
    more, falling back to `tmux kill-session` (SIGHUP) only when
    graceful exit times out. Codex `tm kill` removes a clean worktree
    via `git worktree remove --force`, preserves dirty worktrees with
    a stderr warning.

  On-disk surfaces:

  - Identity schema bumped 1 → 2. New fields: `repo`, `worktreeSlug`.
    Schema 1 records are rejected — kill + respawn.
  - `tmux` session name is `teammate-<name>` directly; the `/` → `__`
    encoding (nested-name support) is removed.
  - SessionStart env identity gate is `CLAUDEMUX_TEAMMATE_NAME`
    (previously `CLAUDEMUX_TEAMMATE_REPO`).

  `tm ls` / `tm states` now emit `NAME / REPO / WORKTREE / ENGINE /
STATE` (and the runtime cells for `tm states`).

  `.worktreeinclude` is not yet supported on the Codex self-managed
  path; copy any required gitignored files (`.env`, etc.) into the
  worktree manually for Codex teammates. Claude teammates inherit
  Claude Code's native `.worktreeinclude` handling.

  Research: https://www.feishu.cn/docx/P5fOdzDkFoEisQxRupNcIKsxnJf

## 1.0.0-beta.9

### Patch Changes

- fe1b73e: fix next beta release workflow prerelease changeset consumption

## 1.0.0-beta.8

### Patch Changes

- 413b638: fix: correct cron host rule — `tm`-spawned Claude tmux sessions can also host CronCreate jobs; only `claude -p` and Agent Teams subagents silently fail to fire

## 1.0.0-beta.7

### Patch Changes

- 41a40a4: fix Codex UI IPC discovery for follower control requests

## 1.0.0-beta.6

### Patch Changes

- 2c59de8: fix Codex UI IPC follower interrupt and steering controls

## 1.0.0-beta.5

### Patch Changes

- 50ea451: fix Codex UI IPC live snapshot broadcasts by sending the method schema version
- 43791e5: switch the next beta release workflow direct push to the claudemux release GitHub App token
- d7515cf: switch next beta release workflow to direct push without GitHub App credentials

## 1.0.0-beta.4

### Minor Changes

- 78c5174: add Codex UI IPC bridge for live Desktop and VS Code visibility
- 85baeaf: migrate release pipeline to Changesets

### Patch Changes

- 50ab7a0: add next beta release automation workflow
- 7461c71: add promote-main and reset-next-pre release workflows
- 6013007: add changeset-status CI gate
