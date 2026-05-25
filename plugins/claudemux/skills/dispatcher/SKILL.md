---
name: dispatcher
description: Manage dispatcher-style coordination across sibling git repos from a parent workspace. Use when the user asks to spawn, dispatch, message, resume, inspect, compact, or kill Claude/Codex teammates; run one-shot Codex pool work with tm ask; coordinate work across sibling repos; check teammate state; host local scheduled work; maintain the dispatcher task ledger; run an adversarial cross-engine review of a PR; or run a heterogeneous design-direction negotiation. Also use when the user names dispatcher concepts such as "send out a teammate / spin up a teammate / dispatch a task / check what X is doing / multi-repo / dispatcher / send a reviewer / review this PR / adversarial review / cross-engine review / heterogeneous design negotiation / get a second model's opinion / merge this PR".
---

# Dispatcher: multi-repo teammate orchestrator

Operations manual for dispatcher-style work from a parent directory of sibling git repos. The dispatcher routes target-repo work to repo-local Claude or Codex execution, waits, reads back, updates the task ledger, and reports the result. Detailed per-scenario operational steps live in `references/<scenario>.md`.

> **`tm` is the helper script** bundled with this plugin. Examples below call it as bare `tm`. Claude Code auto-prepends each installed plugin's `bin/` directory to `PATH`, so `which tm` resolves inside any Bash subshell of an interactive Claude Code session. If `tm` is not on `PATH`, use the absolute install path: `~/.claude/plugins/cache/claudemux/claudemux/<version>/bin/tm`. **Do not** rely on `${CLAUDE_PLUGIN_ROOT}` from a generic Bash tool call; that variable is injected only when the harness runs plugin-defined commands, hooks, or skill bodies.

> **Verb contracts live in the script.** `tm --help` is the top-level synopsis; `tm <verb> --help` (or `tm help <verb>`) is the detailed flag/output contract for each verb. The shipped help is the source of truth. References in this skill explain scenario flow and edge cases; read `--help` for flags and exact stdout/stderr contracts.

## Confirm dispatcher scope

- The user asks to push work into another repo ("派一个到 `<repo>`", "去 `<repo>` 看看 X").
- The user asks about an existing teammate ("看看 alarm 在干啥", "问问 monorepo-1 现在的 git status").
- The user asks for a scheduled / recurring local job.
- The user asks to coordinate across multiple sibling repos or maintain the dispatcher task ledger.

If the request is a normal single-repo or single-file task inside a covered sibling repo, resolve the target repo and delegate the work into that repo. Keep repo-local instructions, git state, and tool output inside the worker context instead of mixing them into the dispatcher.

## Pick the right delegation form

Pick once, up front; switching delegation form mid-task requires rebuilding state in the new form. Use the dispatcher's own shell for dispatcher bookkeeping (`tm`, ledger edits, cron setup); use delegated execution for target-repo inspection or modification.

| Form | Pick when | Skip when |
|---|---|---|
| `claude -p` headless in the target repo | One-shot repo task that can finish in a single delegated turn, including reads, small edits, or focused analysis | You need a cron / loop / wakeup; you want to keep talking to it later |
| `Agent` teammate via Agent Teams (`team_name=<...>` on the Agent tool) | Parallel work across multiple repos that needs a shared task list or peer `SendMessage` | You need cron firing inside the teammate; you need teammate-level cwd; you need session resume; you need nested sub-teams |
| Claude tmux teammate (`tm spawn <repo>`) | Long-running Claude work that needs a real TUI REPL, a Remote Control session, resume, or optional cron tied to that teammate's lifecycle | Throwaway one-shot work; Codex-specific work |
| Persistent Codex daemon teammate (`tm spawn <name> --engine codex`) | Long-running Codex work that needs a named daemon and resumable persistent thread | Throwaway one-shot Codex work; cron or TUI-only behavior |
| Codex pool one-shot (`tm ask "..."`) | One Codex turn on a fresh ephemeral thread using an already-spawned idle Codex daemon | You need a named persistent Codex thread, ledger tracking, or later resume |

Cron firing is reliable only inside an interactive TUI REPL: this dispatcher, or a Claude tmux teammate launched by `tm spawn`. Keep cron on this dispatcher unless the user specifically wants the job tied to a Claude teammate's lifecycle. Do not host cron jobs in `claude -p`, Agent Teams, or Codex daemon teammates.

## Dispatcher posture as router

The dispatcher routes work into sibling repos; it does not investigate target-repo code itself. Two corollaries that show up often:

- **Hand the symptom to the teammate, not pre-digested conclusions.** When a sibling-repo symptom shows up, spawn the teammate and pass the symptom. Skip `git -C <repo> diff/log`, `grep` inside the sibling repo, and `Read` on sibling files done "to understand the bug first". The teammate has the repo's own context and `CLAUDE.md`; pre-investigation wastes dispatcher context and anchors the teammate to whatever conclusion you already drew before delegating.
- **Expect the user to drive teammates directly.** Remote Control web UI, mobile, and claude.ai/code give the user a private channel to each Claude tmux teammate; many interactions never pass through `tm send`. Surface the Remote Control URL in the ledger at spawn time and do not reflexively offer to relay user messages through the dispatcher. The teammate's own recap is the source of truth for what happened in that channel, even when the dispatcher was not the prompt source.
- **A teammate citing instructions the dispatcher never saw is the expected case.** See `references/wait-and-readback.md` §"A reply may cite instructions you never saw" for the handling rule — default reading is "user spoke directly", not "teammate fabricated".

## The `tm` script

`tm` resolves the dispatcher directory from `TM_DISPATCHER_DIR` if set, otherwise `$PWD`. `/claudemux:setup` writes `TM_DISPATCHER_DIR` into the dispatcher root's `.claude/settings.json` so Claude Code injects it on dispatcher launch. If `tm doctor` reports `TM_DISPATCHER_DIR: unset` or points at the wrong directory, run `/claudemux:setup` from the dispatcher root or ask the user to relaunch there.

For Claude teammates, `<repo>` is the short name of a sibling subdirectory directly under the dispatcher dir; `tm spawn my-repo` starts tmux session `teammate-my-repo` with cwd `<dispatcher-dir>/my-repo`. Codex teammates are daemons, not tmux sessions; spawn them explicitly with `tm spawn <name> --engine codex`.

## Scenario routing

Match the user's intent to one scenario, then read the corresponding reference. Each reference is self-contained; read just the one that applies.

| When you're doing this | Read | Primary verb(s) |
|---|---|---|
| Pushing work into a repo via Claude tmux teammate | `references/dispatch-task.md` | `tm spawn <repo> --prompt "..."` / `tm send <repo> --prompt "..."` |
| Pushing work into a persistent Codex daemon teammate | `references/dispatch-task.md` | `tm spawn <name> --engine codex` / `tm send <name> --prompt "..."` |
| Borrowing an idle Codex daemon for one fresh ephemeral turn | `references/dispatch-task.md` | `tm ask "..."` |
| Composing a spawn / send prompt that references sibling-repo state | `references/sibling-memory.md` | `tm mem <repo>` |
| Waiting for a turn an external actor drove | `references/wait-and-readback.md` | `tm wait --fresh <repo>` / `tm wait <codex-name>` |
| Reading the fleet snapshot | `references/inspect-and-resume.md` | `tm states` |
| A teammate looks hung mid-turn and needs pane/process ground truth | `references/wait-and-readback.md` | `tm status <repo>` |
| Looking up past sessions or threads / resuming / re-reading a reply | `references/inspect-and-resume.md` | `tm history <repo>` / `tm resume <repo> <id>` / `tm last <repo>` |
| Checking or compacting a Claude teammate's context window | `references/compact-a-teammate.md` | `tm ctx <repo>` / `tm compact <repo>` |
| Appending a new active task or archiving a finished one | `references/ledger-and-archive.md` | `tm archive <id>` |
| Spawning an Agent Teams teammate | `references/agent-teams.md` | `Agent(team_name=...)` |
| Diagnosing `.sid` drift, a stuck Claude spawn, or surprising `tm states` output | `references/sid-rotation.md` | (debugging) |
| Fanning `/reload-plugins` to teammates after a plugin update | (no reference) | `tm reload --all` (or `tm reload <repo>...`) |
| Running an adversarial cross-engine review of a PR | `references/heterogeneous-review.md` | `tm spawn <reviewer> --engine <opposite>` |
| Running a heterogeneous design-direction negotiation | `references/heterogeneous-negotiation.md` | parallel `tm spawn` of one claude TM + one codex TM |

For any verb's flag/output contract: `tm <verb> --help`. Do not reason about `tm` from prior-conversation memory or model priors.

## Long-running waits

Run every verb that may block longer than a couple of seconds with `run_in_background: true` on the Bash tool. This covers `tm send` (sync default, blocks until Stop), `tm wait`, `tm spawn --prompt`, `tm resume --prompt`, `tm compact` (default 1800 s cap), `tm poll`, `tm reload`, and any file-polling loop you write yourself. After the call is backgrounded, wait for the task notification; do not chain `sleep N && cat <output-file>` to peek at the background output file.

Foreground waits block the dispatcher end-to-end, so keep foreground use to non-wait operations such as `tm ls`, `tm states`, `tm status`, `tm last`, `tm ctx`, `tm history`, `tm archive`, `tm kill`, `tm doctor`, `tm resume` without `--prompt`, and `tm spawn` without `--prompt` when you intentionally want launch readiness before continuing.

Long `sleep` chains are blocked by the harness sandbox. For "wait until X", use `until <check>; do sleep 4; done` with a time-bounded outer loop; run that loop in the background like every wait.

## Cron host rule

This dispatcher is the preferred cron host on this machine. The scheduler ticks only inside an interactive TUI REPL, not inside `claude -p`, Agent Teams teammates, or Codex daemon teammates.

- Place periodic work here. If the work itself belongs to a specific repo, the callback prompt can dispatch outward with Bash, `claude -p`, `tm send`, or a fresh delegated teammate.
- Jobs fire only while you are idle. Ongoing conversation delays firing.
- Jobs are session-only by default and die when this dispatcher process dies (`tmux kill-session dispatcher`, terminal close while not detached, Mac reboot).
- Recurring jobs auto-expire after 7 days.
- For approximate times, pick an off-minute (e.g. `7 * * * *`, not `0 * * * *`) because the platform-wide fleet aliases on `:00` and `:30`.

## Local dispatcher notes

User-specific notes accumulated by `/claudemux:optimize` live in `.claude/local-dispatcher-notes.md` under the dispatcher directory. At the start of a dispatcher session, check whether that file exists and read it if so. It is user-owned and survives plugin upgrades: anything that would be lost on a plugin update belongs there, not in the plugin-shipped skill body.

## Tool permission requests

The auto-mode classifier blocks the dispatcher from editing its own `settings.local.json` to grant itself new tool permissions. When the dispatcher needs a new Bash permission, hand the user a minimal JSON snippet to merge into `~/.claude/settings.local.json`, or point them at `/permissions` to do it interactively:

```json
{ "permissions": { "allow": ["Bash(<command>:*)"] } }
```

## User-facing reports

A reply to the user that asserts an outcome must be verifiable from this turn's tool calls. The wrap-up sentence of a status report is where rounded-off fabrication tends to slip in; these four rules keep it honest:

- **Verify any command, slash command, endpoint, flag, or file path before naming it in a user-facing reply.** Check the system-reminder skill list, run `<cli> --help`, or `ls` the path. If you cannot verify it in this turn, omit the wording or say "not sure of the exact verb" — a confident-wrong name drops trust harder than a terse "I don't know".
- **Translate dispatcher-internal identifiers to plain language before the message goes out.** Internal backlog codes, ad-hoc phase labels, and memory file slugs are invisible to the user and read as gibberish. PR numbers and issue IDs the user can look up are shared vocabulary; keep those intact.
- **Send the "done" reply after the action's tool call returns, not in the same parallel batch.** The auto-mode classifier reads the transcript top-to-bottom; a reply that asserts completion alongside the action looks like a fabricated completion report and can be blocked. Independent calls can still batch — this only constrains an action and the reply that asserts it finished.
- **Run `date` before writing time-sensitive framing.** The session context carries the date but never the time of day, and a past "I'm going to sleep" in the summary says nothing about the present moment. Without checking the clock, phrases like "good morning", "it's late", or "unattended overnight" can be confidently wrong.

## Task ledger boot-up

Two files in this dispatcher's AutoMemory directory power the task ledger; file purposes, schema, and the `tm archive` flow live in `references/ledger-and-archive.md`. The boot rule is:

- **Read on boot**: `active-dispatcher-tasks.md` — before any cross-task decision, and whenever the user asks "what's running" / "看看现在在跑啥".
- **Never read on boot**: `dispatcher-tasks-archive.md` — on demand only, when the user asks about a past task or you need history to make a decision.
