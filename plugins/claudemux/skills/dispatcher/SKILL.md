---
name: dispatcher
description: Manage dispatcher-style coordination across sibling git repos from a parent workspace. Use when the user asks to spawn, dispatch, message, resume, inspect, compact, or kill Claude/Codex teammates; run one-shot Codex pool work with tm ask; coordinate work across sibling repos; check teammate state; or maintain the dispatcher task ledger. Also use when the user names dispatcher concepts such as "send out a teammate / spin up a teammate / dispatch a task / check what X is doing / multi-repo / dispatcher".
---

# Dispatcher: multi-repo teammate orchestrator

Operations manual for dispatcher-style work from a parent directory of sibling git repos. The dispatcher routes target-repo work to repo-local Claude or Codex execution, waits, reads back, updates the task ledger, and reports the result. Detailed per-scenario operational steps live in `references/<scenario>.md`.

> **`tm` is the helper script** bundled with this plugin. Examples below call it as bare `tm`. Claude Code auto-prepends each installed plugin's `bin/` directory to `PATH`, so `which tm` resolves inside any Bash subshell of an interactive Claude Code session. If `tm` is not on `PATH`, use the absolute install path: `~/.claude/plugins/cache/claudemux/claudemux/<version>/bin/tm`. **Do not** rely on `${CLAUDE_PLUGIN_ROOT}` from a generic Bash tool call; that variable is injected only when the harness runs plugin-defined commands, hooks, or skill bodies.

> **Use live help for executable CLI contracts.** `tm --help` is the top-level synopsis; `tm <verb> --help` (or `tm help <verb>`) owns flags, accepted arguments, exit codes, and exact stdout/stderr contracts. This skill and its references own operational semantics, scenario selection, and edge cases. Keep the two in sync; do not reason about `tm` from prior-conversation memory or model priors.

## Confirm dispatcher scope

- The user asks to push work into another repo ("派一个到 `<repo>`", "去 `<repo>` 看看 X").
- The user asks about an existing teammate ("看看 alarm 在干啥", "问问 monorepo-1 现在的 git status").
- The user asks to coordinate across multiple sibling repos or maintain the dispatcher task ledger.

If the request is a normal single-repo or single-file task inside a covered sibling repo, resolve the target repo and delegate the work into that repo. Keep repo-local instructions, git state, and tool output inside the worker context instead of mixing them into the dispatcher.

## Dispatcher posture as router

The dispatcher routes work into sibling repos; it does not investigate target-repo code itself. Two corollaries that show up often:

- **Hand the symptom to the teammate, not pre-digested conclusions.** When a sibling-repo symptom shows up, spawn the teammate and pass the symptom. Skip `git -C <repo> diff/log`, `grep` inside the sibling repo, and `Read` on sibling files done "to understand the bug first". The teammate has the repo's own context and `CLAUDE.md`; pre-investigation wastes dispatcher context and anchors the teammate to whatever conclusion you already drew before delegating.
- **Expect the user to drive teammates directly.** Remote Control web UI, mobile, and claude.ai/code give the user a private channel to each Claude tmux teammate; many interactions never pass through `tm send`. Surface the Remote Control URL in the ledger at spawn time and do not reflexively offer to relay user messages through the dispatcher. The teammate's own recap is the source of truth for what happened in that channel, even when the dispatcher was not the prompt source.
- **A teammate citing instructions the dispatcher never saw is the expected case.** See `references/wait-and-readback.md` §"A reply may cite instructions you never saw" for the handling rule — default reading is "user spoke directly", not "teammate fabricated".
- **`.workspace/artifacts/` is the dispatcher's own scratch space.** When you need to park a triage table, research dump, design draft, or any intermediate output that should survive a reboot, write `<dispatcher-dir>/.workspace/artifacts/<YYYYMMDD>-<slug>.md` instead of `/tmp/<topic>.md`. The task ledger stays in AutoMemory (see `references/ledger-and-archive.md`) — `.workspace/` does not mirror or replace it. Don't direct teammates to write into the dispatcher's `.workspace/`; their work belongs in their own repo or `/tmp/`. Layout: `.workspace/imports.md` (auto-loaded into your context via `CLAUDE.md`) and `.workspace/README.md`.

## The `tm` script

`tm` resolves the dispatcher directory from `TM_DISPATCHER_DIR` if set, otherwise `$PWD`. `/claudemux:setup` writes `TM_DISPATCHER_DIR` into the dispatcher root's `.claude/settings.json` so Claude Code injects it on dispatcher launch. If `tm doctor` reports `TM_DISPATCHER_DIR: unset` or points at the wrong directory, run `/claudemux:setup` from the dispatcher root or ask the user to relaunch there.

`tm spawn <path>` is the only verb that takes a filesystem path; every other teammate verb takes the flat `<name>` returned by spawn. The path may be absolute or relative to the dispatcher dir; `realpath` resolves it and `identity.repo` records the result. The teammate name is auto-generated as `<basename(path)>-<rand4>` unless you pass `--name <id>` (`^[A-Za-z0-9][A-Za-z0-9_-]*$`, globally unique). Spawn returns `spawned: <name>` on stderr — **capture it and record it in the active-task ledger**; every subsequent `tm send` / `tm wait` / `tm kill` / `tm last` / `tm mem` routes by name, not by path.

By default a Claude teammate runs inside a worktree at `<path>/.claude/worktrees/<name>/` (branch `worktree-<name>`, base ref `HEAD`); pass `--no-worktree` for repo-wide tasks where worktree isolation is a hindrance. Codex teammates default to a self-managed git worktree at the same `.claude/worktrees/<name>/` layout (claudemux drives `git worktree add` directly because Codex has no native worktree flag). Codex teammates are daemons, not tmux sessions; spawn them explicitly with `tm spawn <path> --engine codex`. Names are flat — nested `codex/foo` form is no longer supported.

## Scenario routing

Match the user's intent to one row below, then **read the listed reference before reaching for the verb** — it covers scenario flow and edge cases. The dispatcher orchestrates teammates exclusively through `tm`; Agent Teams and raw `claude -p` are intentionally not surfaced as dispatcher delegation forms, so every teammate shares the same ledger, identity record, and state tracking.

| When you're doing this | Read | Primary verb(s) |
|---|---|---|
| Pushing work into a repo via Claude tmux teammate | `references/dispatch-task.md` | `tm spawn <path> --prompt "..."` / `tm send <name> --prompt "..."` |
| Pushing work into a persistent Codex daemon teammate | `references/dispatch-task.md` | `tm spawn <name> --engine codex` / `tm send <name> --prompt "..."` |
| Borrowing an idle Codex daemon for one fresh ephemeral turn | `references/dispatch-task.md` | `tm ask "..."` |
| Composing a spawn / send prompt that references sibling-repo state | `references/sibling-memory.md` | `tm mem <name>` |
| Waiting for a turn an external actor drove | `references/wait-and-readback.md` | `tm wait --fresh <name>` / `tm wait <name>` |
| Reading the fleet snapshot | `references/inspect-and-resume.md` | `tm states` |
| A teammate looks hung mid-turn and needs pane/process ground truth | `references/wait-and-readback.md` | `tm status <name>` |
| Looking up past sessions or threads / resuming / re-reading a reply | `references/inspect-and-resume.md` | `tm history <name>` / `tm resume <name> <id>` / `tm last <name>` |
| Compacting a Claude teammate's context window | `references/compact-a-teammate.md` | `tm compact <name>` |
| Appending a new active task or archiving a finished one | `references/ledger-and-archive.md` | `tm archive <id>` |
| Diagnosing `.sid` drift, a stuck Claude spawn, or surprising `tm states` output | `references/sid-rotation.md` | (debugging) |
| Fanning `/reload-plugins` to teammates after a plugin update | (no reference) | `tm reload --all` (or `tm reload <name>...`) |

For any verb's flag/output contract: `tm <verb> --help`. Do not reason about `tm` from prior-conversation memory or model priors.

## Default to parallel dispatch

The dispatcher exists to fan work out across teammates, worktrees, and engines at the same time. When the user names N independent tasks, default to parallel execution — N teammates handle N tasks and the user gets the results back in roughly the time of the slowest one. Serializing the work matches the wall-clock of not routing through a dispatcher at all.

- **One long-running verb per Bash call; fire N calls in parallel.** Every `tm` verb that can block past a few seconds (`tm send`, `tm wait`, `tm spawn --prompt`, `tm resume --prompt`, `tm compact`, `tm poll`, `tm reload` — full set in the next section) goes in its own Bash tool call with `run_in_background: true`. To run N of them concurrently, issue N independent Bash calls in the same model response; the harness fires a separate completion notification per call, so the dispatcher reacts to each teammate's result the moment it arrives instead of waiting for the slowest. Do NOT combine multiple long-running verbs in one Bash command (no `tm send A && tm send B`, no `tm send A &; tm send B &; wait`, no for-loop wrapper) — combining them collapses N notifications into one and serializes the dispatcher's response cadence behind the slowest task. Short dispatcher-local work (`gh` post, file write, `git -C <repo>` probe) rides along as additional Bash calls in the same model response.
- **State the parallel plan before the batch.** A user reading the dispatcher's reply should see the parallelism, not merely experience it. "Two in parallel: ① fix-auth in `<repo-a>`; ② regen-types in `<repo-b>`" beats "I'll do A first, then B" — serial framing reads as serial work even when the actual tool batch is concurrent. Drop "first … then …" wording from the plan when the tasks are independent; if there is a true sequential dependency, name it.
- **Serialize only on a named cause.** Real data dependency (B reads A's output), shared mutable state that would conflict (same teammate name in the `tm` namespace, same git worktree, same shared lock file), or an explicit user ask. Otherwise default to parallel framing.

This pairs with the `run_in_background: true` mechanics in the next section (that flag is what keeps the parallel batch non-blocking) and with the prompt-composition checklist in `references/dispatch-task.md` (each prompt in a parallel batch still needs its own intent, workspace state, hard context, and deliverable shape).

## Long-running waits

Run every verb that may block longer than a couple of seconds with `run_in_background: true` on the Bash tool. This covers `tm send` (sync default, blocks until Stop), `tm wait`, `tm spawn --prompt`, `tm resume --prompt`, `tm compact` (default 1800 s cap), `tm poll`, `tm reload`, and any file-polling loop you write yourself. After the call is backgrounded, wait for the task notification; do not chain `sleep N && cat <output-file>` to peek at the background output file.

Foreground waits block the dispatcher end-to-end, so keep foreground use to non-wait operations such as `tm ls`, `tm states`, `tm status`, `tm last`, `tm history`, `tm archive`, `tm kill`, `tm doctor`, `tm resume` without `--prompt`, and `tm spawn` without `--prompt` when you intentionally want launch readiness before continuing.

The harness sandbox blocks `sleep` calls longer than a few seconds. To wait for an external condition (a file appearing, a process exiting, a status flipping), run a bounded polling loop in the background: `until <check>; do sleep 4; done` wrapped in `run_in_background: true`. The sandbox doesn't object to many short sleeps; it objects to one long one.

## User-facing reports

A reply to the user that asserts an outcome must be verifiable from this turn's tool calls. The wrap-up sentence of a status report is where rounded-off fabrication tends to slip in; these four rules keep it honest:

- **Verify any command, slash command, endpoint, flag, or file path before naming it in a user-facing reply.** Check the system-reminder skill list, run `<cli> --help`, or `ls` the path. If you cannot verify it in this turn, omit the wording or say "not sure of the exact verb" — a confident-wrong name drops trust harder than a terse "I don't know".
- **Translate dispatcher-internal identifiers to plain language before the message goes out.** Internal backlog codes, ad-hoc phase labels, and memory file slugs are invisible to the user and read as gibberish. PR numbers and issue IDs the user can look up are shared vocabulary; keep those intact.
- **Send the "done" reply after the action's tool call returns, not in the same parallel batch.** The auto-mode classifier reads the transcript top-to-bottom; a reply that asserts completion alongside the action looks like a fabricated completion report and can be blocked. Independent calls can still batch — this only constrains an action and the reply that asserts it finished.
- **Run `date` before writing time-sensitive framing.** The session context carries the date but never the time of day, and a past "I'm going to sleep" in the summary says nothing about the present moment. Without checking the clock, phrases like "good morning", "it's late", or "unattended overnight" can be confidently wrong.

## Task ledger boot-up

Two files in this dispatcher's Claude Code memory directory (`~/.claude/projects/<encoded-cwd>/memory/`) power the task ledger; file purposes, schema, and the `tm archive` flow live in `references/ledger-and-archive.md`. The boot rule is:

- **Read on boot**: `active-dispatcher-tasks.md` — before any cross-task decision, and whenever the user asks "what's running" / "看看现在在跑啥".
- **Never read on boot**: `dispatcher-tasks-archive.md` — on demand only, when the user asks about a past task or you need history to make a decision.
