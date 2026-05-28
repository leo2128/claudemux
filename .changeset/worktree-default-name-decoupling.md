---
"claudemux": major
---

worktree default + name/repo decoupling (schema 2)

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
