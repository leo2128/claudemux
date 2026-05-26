# Dispatch a task to a teammate (scenario reference)

Read this when you need to push work into a sibling repo or Codex teammate: bring up a new teammate, hand follow-up work to an existing one, or borrow the Codex pool for one turn. Skip when you only need to read teammate state (`wait-and-readback.md`) or look up past sessions (`inspect-and-resume.md`).

The dispatcher dir is resolved as `${TM_DISPATCHER_DIR:-$PWD}` (see SKILL.md `tm` overview). For Claude teammates, `<repo>` is the short name of a sibling subdirectory directly under it.

## Choose the execution path

| Situation | Verb |
|---|---|
| Fresh Claude tmux teammate and first task in one shot | `tm spawn <repo> --prompt "..."` |
| Fresh Claude tmux teammate, no task yet | `tm spawn <repo>` |
| Existing Claude tmux teammate, send a new task and get the reply | `tm send <repo> --prompt "..."` |
| Fresh persistent Codex daemon teammate and optional first task | `tm spawn <name> --engine codex [--prompt "..."]` |
| Existing persistent Codex daemon teammate, send a new task | `tm send <name> --prompt "..."` |
| One-shot Codex pool turn on a fresh ephemeral thread | `tm ask "..."` |

Run `tm spawn --help`, `tm send --help`, and `tm ask --help` for the exact flag/output contract. The shipped help is the source of truth; this file explains selection and surrounding mechanics.

## Composing the spawn / send prompt

Before pressing enter on `tm spawn --prompt` or `tm send --prompt`, audit the prompt text against these rules. Teammates default to behaving reasonably; the failure mode is the dispatcher adding noise that hobbles or misleads them.

1. **Keep the prompt minimal.** Aim for roughly the length and shape the user would type if they were dispatching the task themselves: a one-line business request plus only the conventions the teammate cannot infer (an opaque external ID, a required output channel such as a Feishu document). Stop there. A teammate handed a one-line task picks its own investigative path; a teammate handed a checklist anchors to your preconception of what matters and stops exploring. Common noise to keep out: a list of sub-questions ("cover these six points"); a "known traps" or "gotchas" section listing hypotheses the dispatcher has not verified against file:line in this turn (an unverified hypothesis injected as a premise is exactly what the teammate has to detox before it can think); reminders of behavior the teammate does by default (read before edit, use `advisor` when stuck, do not fabricate); generic exhortations ("be careful", "double-check"). If the draft exceeds about ten lines, audit each line against "would the teammate not otherwise know this".

2. **Do not invent restrictions.** Skip "don't `advisor`", "don't open a new branch", "don't `grep` X" unless you have a concrete justification: the restricted action has demonstrably caused a foot-gun on this exact task; or it has a concrete cost the teammate cannot see (CI is already running on this commit); or the user explicitly said so. Restating something you are worried about is not a valid reason — it just removes the teammate's escalation channels right when it needs them.

3. **Do not fabricate the user's decisions.** Never write "user decided X" / "the user picked Y" / "the user said to do Z" in a teammate prompt when the user has not actually said that. Vague user input like "explore it" / "spin it up and see" / "go ahead" does not authorize you to pick an option from a multi-choice list on the user's behalf and forward it as a settled decision. Acid test: would a recording of the user's last few messages show them saying the words you are about to attribute to them? If not, forward the open question to the teammate and let it choose (or report back before acting), or ask the user one short clarifying question.

4. **Do not write "ping dispatcher" / "report back to dispatcher".** The dispatcher is an interactive REPL, not a `tm send` target. Saying "ping dispatcher" gives the teammate an unresolvable instruction; the Codex driver interprets such lines literally and searches for the closest dispatcher-shaped target — typically the main-repo Claude teammate whose name matches the repo — and runs `tm send <main-repo-tm>` against it. That teammate's auto-mode then burns a turn auto-acknowledging the unsolicited message. End the teammate's prompt at "write the artifact at `<path>` and stop" or "open the PR and stop". The Stop hook plus the `run_in_background: true` task-completion notification deliver the report; no separate ping is needed.

5. **Do not paste repo file paths or "Read X first" hints.** When the target repo runs a progressive context-load mechanism (its own `CLAUDE.md`, a `.agents/`-style knowledge base, a `context-load` script wired into spawn), write the prompt as a natural business request in the repo's product terminology. The repo's own disclosure mechanism is more accurate and more current than any path snapshot the dispatcher carries; pasted paths go stale as the knowledge base evolves, and a stale hint actively makes the teammate worse than no hint at all. If you genuinely need to point at a session-local artifact (a `/tmp/foo.md` you just wrote, a PR URL you just opened), that is fine — it is current state, not a knowledge-base path.

## The wait phase

`tm spawn --prompt`, `tm send`, `tm wait`, `tm resume --prompt`, and `tm ask` can block for a full model turn. Run them with `run_in_background: true` on the Bash tool so the dispatcher stays free; the harness fires a task notification when the verb returns.

Claude sync paths block until the teammate's next Stop hook fires (`--timeout 1800` default). Persistent Codex sync paths use the Codex driver, print the final assistant text on stdout, and write the raw Turn JSON to `/tmp/teammate-codex/<name>/last-turn.json`; read it with `tm last <name> --verbose` when needed. `--pane-quiet` is rejected on Codex targets. `tm ask` prints one ephemeral Turn JSON and releases the borrowed daemon.

## Exit codes for sync verbs

`tm spawn --prompt`, `tm send`, `tm wait`, and `tm compact` use the same high-level split:

- **`0`** — the reply or completion signal landed within `--timeout`; stdout contains the reply text or verb-specific success line. `tm ask` is the Codex exception that still prints an ephemeral Turn JSON.
- **`124`** — sync wait expired and the teammate is still running. Do not respawn; the teammate name is still taken. Collect the late result with `tm wait <repo>` for Claude, or retry the relevant Codex wait/send flow after checking state.
- **`1`** — true failure: no teammate, missing sid/thread marker, broken send path, invalid repo/name, or the command was rejected.

Read stderr before deciding the next step; timeout paths name the recovery verb when one applies.

## Current-state command rules

- For reload fan-out across teammates, use `tm reload --all` or `tm reload <repo>...`.
- For externally driven Claude turns (Remote Control web UI, mobile, the teammate's own sub-agents), collect the next reply with `tm wait --fresh <repo>`; for Codex daemon turns, use `tm wait <name>`.
- For stopping a teammate, use `tm kill <repo>`; it clears the matching on-disk state for that engine.

## Claude tmux teammate setup

When you `tm spawn <repo>` on the default Claude engine:

1. **cwd** = `<dispatcher-dir>/<repo>`. The teammate's Claude process is launched there via `tmux new-session -c`.
2. **CLAUDE.md exclusions.** The teammate loads the target repo's own `CLAUDE.md`, but not the dispatcher's `CLAUDE.md` / `CLAUDE.local.md`.
3. **Remote Control auto-registration.** The teammate's startup banner prints its Remote Control URL, visible via `tm status <repo>`.
4. **sid pre-generation.** `tm` generates a UUID, passes it to `claude --session-id <uuid>`, writes `/tmp/teammate-<repo>.sid`, and creates the idle/.last machinery used by waits.
5. **Fresh `.last` sentinel.** A fresh spawn writes an empty `/tmp/claude-idle/<sid>.last`; `tm last` before any reply returns a clear "no reply yet" error instead of stale text.
6. **AskUserQuestion disabled.** Teammates raise questions by ending the turn with text, which `tm send` / `tm spawn --prompt` relays back. Do not instruct the teammate to ask via that tool.
7. **`--task <slug>`.** Names the conversation `<repo>-<slug>` for the prompt box, `/resume` picker, and terminal title. ASCII letters/digits plus CJK Unified Ideographs are accepted; ASCII letters are lowercased, other runs collapse to `-`, and the slug is capped at 30 code points. Without `--task`, a fresh spawn auto-names `<repo>-<rand4>`.

## Persistent Codex daemon teammates

Spawn persistent Codex explicitly:

```bash
tm spawn <name> --engine codex
```

Key differences from the Claude path:

- Codex teammates are daemons under `/tmp/teammate-codex/<name>/`, not tmux sessions.
- The name itself has no engine meaning; `codex-reviewer` is still a Claude teammate unless `--engine codex` is present.
- If `<name>` matches a sibling subdirectory, the daemon cwd is that repo; otherwise it uses the dispatcher dir.
- `--task` is rejected on Codex spawn.
- `tm send <name> --prompt "..."` writes or resumes the daemon's persistent thread, prints final assistant text on stdout, and reports `sent` / `sid` / `ctx` / `raw` status lines on stderr.
- `tm kill <name>` reaps the daemon and registry directory instead of killing a tmux session.

Use this path when the user needs a named Codex teammate or resumable Codex thread. Use `tm ask` for throwaway Codex one-shots.

## Codex pool one-shots: `tm ask`

`tm ask "<prompt>"` borrows one alive idle Codex daemon, starts a fresh ephemeral thread, runs the prompt, prints the Turn JSON to stdout, and releases the daemon. It does not pollute the daemon's persistent conversation thread.

Preconditions and failures:

- At least one Codex daemon must already exist (`tm spawn <name> --engine codex`).
- If every recorded daemon is dead, run `tm doctor` to reap stale state or spawn a new daemon.
- If every alive daemon is borrowed, retry later or spawn one more daemon.

## Two reflexes to avoid

- **Don't `tm spawn` then immediately `tm send`** for a bootstrap. `tm spawn --prompt "..."` does both atomically in one call and returns the first-turn result on stdout.
- **Don't `cd <sibling-repo> && <cmd>`** to inspect a repo before dispatching to it. The Bash tool persists `cd` across invocations. Use `git -C <repo> <cmd>` for per-repo inspection, or `(cd <repo> && <cmd>)` as a subshell. Confirm `TM_DISPATCHER_DIR` with `tm doctor`.

## Resuming a prior task

If the user wants to continue a task whose teammate has died (dispatcher restarted, `tm kill`, Mac reboot), use `tm resume <repo> <sid-or-thread-id>` with the id pulled from the active ledger or `tm history <repo>`. See `inspect-and-resume.md`.

## Recording the task in the ledger

Every spawn that produces work worth tracking should append an entry to `active-dispatcher-tasks.md` at spawn time: sid/thread id when available, branch, intent, and artifacts you expect to fill later. Schema and entry shape live in `ledger-and-archive.md`. Skip this only for truly throwaway one-shot calls such as `tm ask` or a one-line "what's your branch?" probe.
