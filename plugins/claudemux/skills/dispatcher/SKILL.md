---
name: dispatcher
description: Manage dispatcher-style coordination across sibling git repos from a parent workspace. Use when the user asks to spawn, dispatch, message, resume, inspect, or kill a teammate; coordinate work across multiple sibling repos; check what teammates are doing; host or manage local scheduled work; or maintain the dispatcher task ledger. Also use when the user names dispatcher concepts such as "派一个 / 起一个 teammate / 下发任务 / 看看 X 在干啥 / 多仓 / dispatcher".
user-invocable: false
---

# Dispatcher: multi-repo Claude orchestrator

Operations manual for dispatcher-style work from a parent directory of sibling git repos. The dispatcher routes target-repo work to a repo-local Claude process or teammate, then waits, reads back, updates the task ledger, and reports the result. This file is the always-loaded skeleton: scope check, delegation choice, the `tm` overview, a scenario routing table to detailed references, and a handful of invariants every flow shares. Detailed per-scenario operational steps live in `references/<scenario>.md`.

> **`tm` is the helper script** bundled with this plugin. Examples below call it as bare `tm`. Claude Code auto-prepends each installed plugin's `bin/` directory to `PATH`, so `which tm` resolves inside any Bash subshell of an interactive Claude Code session. If for some reason `tm` is not on `PATH`, use the absolute install path: `~/.claude/plugins/cache/claudemux/claudemux/<version>/bin/tm`. **Do not** rely on `${CLAUDE_PLUGIN_ROOT}` from a generic Bash tool call — that variable is only injected when the harness runs commands defined by the plugin (commands/hooks/skill bodies), not in arbitrary subshells you spawn from elsewhere.

> **Verb contracts live in the script.** `tm --help` is the top-level synopsis (one line per verb); `tm <verb> --help` (or `tm help <verb>`) is the detailed flag/output contract for each verb. The shipped help is the single source of truth and never goes stale relative to `bin/tm`. References in this skill explain the surrounding mechanics and scenario flow — they do not duplicate the per-verb contracts. If you need a flag, read `--help`.

## Confirm dispatcher scope

- The user asks to push work into another repo ("派一个到 `<repo>`", "去 `<repo>` 看看 X").
- The user asks about an existing teammate ("看看 alarm 在干啥", "问问 monorepo-1 现在的 git status").
- The user asks for a scheduled / recurring local job.
- The user asks to coordinate across multiple sibling repos or maintain the dispatcher task ledger.

If the request is a normal single-repo or single-file task inside a covered sibling repo, resolve the target repo and delegate the work into that repo. This keeps repo-local instructions, git state, and tool output inside the worker context instead of mixing them into the dispatcher.

## Pick the right delegation form

Three ways to push work outward. Pick once, up front — switching mid-task is painful. Use the dispatcher's own shell for dispatcher bookkeeping (`tm`, ledger edits, cron setup); use a delegated Claude process or teammate for target-repo inspection or modification.

| Form | Pick when | Skip when |
|---|---|---|
| `claude -p` headless in the target repo | One-shot repo task that can finish in a single delegated turn, including reads, small edits, or focused analysis | You need a cron / loop / wakeup; you want to keep talking to it later |
| `Agent` teammate via Agent Teams (`team_name=<...>` on the Agent tool) | Parallel work across multiple repos that needs to share a task list or message each other | You need cron firing inside the teammate; you need teammate-level `cwd`; you need session resume; you need nested sub-teams |
| `tmux` teammate (interactive `claude` in a new `tmux` pane, launched by `tm spawn`) | Long-running work that needs a real REPL, must host its own cron, or wants its own Remote Control session for the user to drive directly | Throwaway one-shot work |

Cron firing is reliable **only inside an interactive TUI REPL** (this dispatcher, or a tmux teammate launched by `tm spawn`). `claude -p` and Agent Teams teammates both return success from `CronCreate` and then silently never fire (observed empirically). Don't host cron jobs in those forms — keep them on this dispatcher (preferred) or push them into a tmux teammate. See "Cron host rule" below.

## The `tm` script

`tm` (bundled at `bin/tm`) manages tmux teammates. Resolves the dispatcher directory once at invocation, in this order: **`$TM_DISPATCHER_DIR` env if set, otherwise `$PWD`**. `/claudemux:setup` writes `TM_DISPATCHER_DIR` into the dispatcher root's `.claude/settings.json` so Claude Code injects it as env at every dispatcher launch — that keeps `tm` correct even when the Bash tool's cwd has drifted into a sibling repo (the Bash tool persists `cd` across calls). The `$PWD` fallback exists for dispatchers set up before this feature; if `tm doctor` reports `TM_DISPATCHER_DIR: unset`, rerun `/claudemux:setup` to inoculate. If the resolved dispatcher dir is itself a git working tree (common when you're maintaining one of the sibling repos directly), `tm spawn <repo>` will miss — `tm` detects this case and points you at the right `cd …` invocation.

`<repo>` throughout this skill is the short name of a sibling subdirectory directly under the dispatcher dir. `tm spawn my-repo` creates a tmux session `teammate-my-repo` with cwd `<dispatcher-dir>/my-repo` and runs `claude` inside it.

## Scenario routing

Match the user's intent to one of these scenarios, then read the corresponding reference for the full flow. Each reference is self-contained — read just the one that applies.

| When you're doing this | Read | Primary verb(s) |
|---|---|---|
| Pushing work into a repo via tmux teammate (default delegation) | `references/dispatch-task.md` | `tm spawn <repo> --prompt "..."` / `tm send <repo> --prompt "..."` |
| Composing a spawn / send prompt that references sibling-repo state (feature-gate name, branch, in-progress project, owner) | `references/sibling-memory.md` | `tm mem <repo>` |
| Waiting for a turn an external actor (Remote Control, mobile, cron, sub-agent) drove | `references/wait-and-readback.md` | `tm wait --fresh <repo>` |
| Reading `tm states` fleet snapshot — what every teammate is doing right now | `references/inspect-and-resume.md` (`LAST` / `PREVIEW` read the same `.last` file as `tm last`) | `tm states` |
| A teammate looks hung mid-turn — need pane ground truth (e.g. blocked on a permission prompt the hook missed) | `references/wait-and-readback.md` (`--pane-quiet` blind spot + `tm status` fallback) | `tm status <repo>` |
| Looking up past sessions for a repo / picking a sid to resume / re-reading a printed reply | `references/inspect-and-resume.md` | `tm history <repo>` / `tm resume <repo> <sid>` / `tm last <repo>` |
| Checking or compacting a teammate's context window | `references/compact-a-teammate.md` | `tm ctx <repo>` / `tm compact <repo>` |
| Appending a new active task or archiving a finished one | `references/ledger-and-archive.md` | `tm archive <id>` |
| Spawning an Agent Teams teammate (instead of a tmux teammate) | `references/agent-teams.md` | `Agent(team_name=...)` |
| Diagnosing `.sid` drift, a stuck `tm spawn`, or surprising `tm states` output | `references/sid-rotation.md` | (debugging) |
| Fanning `/reload-plugins` to teammates after a plugin update | (no reference — one-liner) | `tm reload --all` (or `tm reload <repo>...`) |

For any verb's flag/output contract: `tm <verb> --help`. Don't reason about `tm` from prior-conversation memory or model priors — the script's help is what's authoritative.

## Long-running waits — run them in the background

**Every verb that may block longer than a couple of seconds MUST run with `run_in_background: true` on the Bash tool.** This covers `tm send` (sync default, blocks until Stop), `tm wait`, `tm spawn --prompt`, `tm resume --prompt`, `tm compact` (default 600 s cap because large contexts take minutes), `tm poll`, and any file-polling loop you write yourself. The harness fires a task-notification when the verb returns with the reply already in stdout. Once a call is backgrounded, wait for that notification — don't chain `sleep N && cat <output-file>` to peek at the background task's output file. The notification already delivers the full stdout when the verb returns; polling the file early only shows a half-written or still-empty reply and burns dispatcher turns for nothing.

A foreground wait blocks the dispatcher end-to-end: it cannot receive or dispatch any other task while it sits there. There is no upside.

The only `tm` calls safe to run foreground (sub-second): `tm ls`, `tm states`, `tm status`, `tm last`, `tm ctx`, `tm history`, `tm archive`, `tm reload`, `tm kill`, `tm doctor`, `tm resume` without `--prompt`, fresh `tm spawn` without `--prompt`. Anything with an implicit or explicit wait phase goes background.

Long `sleep` chains are blocked by the harness sandbox. For "wait until X", use `until <check>; do sleep 4; done` with a time-bounded outer loop — and that loop, like every wait, MUST run with `run_in_background: true`.

## Cron host rule

This dispatcher is the only reliable host for `CronCreate` on this machine. The scheduler ticks only inside an interactive TUI REPL — not inside `claude -p`, not inside Agent Teams teammates (both observed to empty-fire).

- Place periodic work here. If the work itself belongs to a specific repo, the callback prompt can dispatch outward (Bash into the repo, `claude -p`, `tm send`, or spawn a fresh Agent teammate).
- Jobs fire only while you are **idle** (not mid-query). Ongoing conversation delays firing.
- Jobs are session-only by default and die when this dispatcher process dies (`tmux kill-session dispatcher`, terminal close while not detached, Mac reboot).
- Recurring jobs auto-expire after 7 days.
- For approximate times, pick an off-minute (e.g. `7 * * * *`, not `0 * * * *`) — the platform-wide fleet aliases on `:00` and `:30`.

## Local dispatcher notes

User-specific notes accumulated by `/claudemux:optimize` live in `.claude/local-dispatcher-notes.md` under the dispatcher directory. At the start of a dispatcher session, check whether that file exists and Read it if so — it holds user-owned dispatcher conventions you need in context before routing any work. It's user-owned and survives plugin upgrades: anything that would be lost on a plugin update is written here, not into the plugin-shipped skill body.

The auto-mode classifier blocks the dispatcher from editing its **own** `settings.local.json` to grant itself new tool permissions (flagged as "Self-Modification"). When the dispatcher needs a new Bash permission, hand the user a minimal JSON snippet to merge into `~/.claude/settings.local.json` (or point them at `/permissions` to do it interactively):

```json
{ "permissions": { "allow": ["Bash(<command>:*)"] } }
```

## Task ledger boot-up

Two files in this dispatcher's AutoMemory directory power the task ledger; file purposes, schema, and the `tm archive` flow live in `references/ledger-and-archive.md`. The boot rule is:

- **Read on boot**: `active-dispatcher-tasks.md` — before any cross-task decision, and whenever the user asks "what's running" / "看看现在在跑啥".
- **Never read on boot**: `dispatcher-tasks-archive.md` — on demand only (when the user asks about a past task or you need history to make a decision).
