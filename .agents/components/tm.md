# Component: the `tm` CLI

`tm` is the orchestrator CLI — a single ~2150-line Bash script at
[`/plugins/claudemux/bin/tm`](/plugins/claudemux/bin/tm). The dispatcher runs
`tm` to spawn, message, wait on, inspect, and kill teammates. Claude Code
auto-prepends each installed plugin's `bin/` to `PATH`, so `tm` resolves in
any Bash subshell of a Claude Code session.

## Source of truth for the verb contracts

`tm --help` is the verb index; `tm <verb> --help` is the per-verb flag and
output contract. **The shipped help is authoritative** — never reconstruct a
verb's behavior from memory or from this doc. This component doc covers
*structure and editing rules*, not the verb contracts.

## Script structure

The script is one file, organized top to bottom:

| Section | Purpose |
|---|---|
| Header | `set -euo pipefail`, `PREFIX="teammate-"`, `IDLE_DIR`, dispatcher-dir resolution |
| OS-detection helpers | `stat_size`, `stat_mtime`, `stat_mtime_human` — BSD/GNU split, detected once into `_STAT_FLAVOR` |
| Path builders | `sid_file`, `cwd_file`, `ready_file`, `send_at_file`, `idle_marker_for`, `busy_marker_for`, `last_file_for`, `encode_project_dir`, `project_dir_for_repo`, `memory_dir` |
| Internal helpers | `die`, `session_name`, `resolve_pane_target`, `resolve_sid`, `sanitize_task_slug`, `pane_busy`, `iter_repos`, `clear_idle`, `fmt_age`, `fmt_size`, … |
| Shared atomic helpers | `_send_keys`, `_wait_idle_signal`, `_wait_pane_quiet`, `_print_last_or_empty`, `_echo_ctx_to_stderr` |
| `cmd_*` functions | one per verb, each paired with a `help_*` function |
| `main` | help pre-scan, then a `case` over the subcommand |

## Verb families

- **Atomic round-trip verbs** — `spawn --prompt`, `send`, `resume --prompt`,
  `wait`, `compact`. Each sends or triggers a turn, blocks on the Stop-hook
  idle signal, and prints the teammate's reply on **stdout**; status lines
  and the post-turn ctx echo go to **stderr**. This stdout/stderr split is
  deliberate — see [decision 0002](/.agents/decisions/0002-atomic-tm-verbs.md).
- **Read-only / fast verbs** — `ls`, `states`, `last`, `ctx`, `history`,
  `mem`, `doctor`, `kill`, `reload`, `archive`. Sub-second; safe foreground.
- **Diagnostic verbs** — `status` (capture the live pane), `poll` (regex-poll
  intermediate pane state). Used when the atomic verbs do not fit.

## Editing rules — the invariants you must hold

These mirror the repo-root `CLAUDE.md` "Cross-Process & Cross-Platform
Invariants"; they bite hardest inside `tm`. Each has its own decision
record — see [decision 0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md).

- **Never concatenate a protocol path by hand.** Every `/tmp/teammate-*`,
  `/tmp/claude-idle/*`, or `~/.claude/projects/<encoded>/...` path is built
  by a named builder function. Add a builder rather than inlining a string.
- **Never call a flag that differs between BSD and GNU directly.** `stat`,
  `sed -i`, `date -d`, `tail -r`/`tac`, `find -printf`, `readlink -f` go
  through an OS-detected helper. CI runs on Ubuntu and macOS; a BSD-only
  call paired with `|| echo 0` degrades silently on Linux instead of failing
  loudly.
- **Map a teammate cwd → Claude project-dir only via `encode_project_dir`**
  (and its `project_dir_for_repo` wrapper). The encoding — replace every `/`
  *and* `.` with `-` — is an Anthropic-controlled contract; hand-reproducing
  it has already dropped dots and broken `tm resume`.
- **Stay bash-3.2 compatible.** macOS ships bash 3.2. No associative arrays;
  guard array splats under `set -u` with the `${arr[@]+"${arr[@]}"}` form;
  no `readlink -f` (use `cd && pwd -P`).

## Foot-guns

- `tm` resolves the dispatcher directory once at startup:
  `$TM_DISPATCHER_DIR` if set, else `$PWD`. `/claudemux:setup` writes
  `TM_DISPATCHER_DIR` into the dispatcher's `.claude/settings.json` so it
  survives Bash-tool cwd drift. `tm doctor` reports the resolved value.
- Spawned teammates are launched with `tmux new-session -e
  CLAUDEMUX_TEAMMATE_REPO=<repo>`; the SessionStart hook uses that env var
  as an identity gate. A teammate started by raw `tmux` without that `-e`
  will not get sid rotation.
- The `main` help pre-scan stops at the first non-flag positional or at
  `--prompt`, so a `--help` substring *inside* a prompt does not trigger
  help mode.

## See also

- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the `/tmp` file protocol `tm` shares with the hooks.
- [components/hooks.md](/.agents/components/hooks.md) — the other half of that protocol.
- [components/dispatcher-skill.md](/.agents/components/dispatcher-skill.md) — how the dispatcher decides which `tm` verb to call.
