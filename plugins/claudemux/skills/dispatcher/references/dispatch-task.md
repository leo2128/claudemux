# Dispatch a task to a teammate (scenario reference)

Read this when you need to push work into a sibling repo or Codex teammate: bring up a new teammate, hand follow-up work to an existing one, or borrow the Codex pool for one turn. Skip when you only need to read teammate state (`wait-and-readback.md`) or look up past sessions (`inspect-and-resume.md`).

The dispatcher dir is resolved as `${TM_DISPATCHER_DIR:-$PWD}` (see SKILL.md `tm` overview). `<path>` in all spawn calls is resolved relative to this directory.

## Choose the execution path

| Situation | Verb |
|---|---|
| Fresh Claude tmux teammate and first task in one shot | `tm spawn <path> --prompt "..."` |
| Fresh Claude tmux teammate, no task yet | `tm spawn <path>` |
| Existing Claude tmux teammate, send a new task and get the reply | `tm send <name> --prompt "..."` |
| Fresh persistent Codex daemon teammate and optional first task | `tm spawn <path> --engine codex [--prompt "..."]` |
| Existing persistent Codex daemon teammate, send a new task | `tm send <name> --prompt "..."` |
| One-shot Codex pool turn on a fresh ephemeral thread | `tm ask "..."` |

Run `tm spawn --help`, `tm send --help`, and `tm ask --help` for flags, accepted arguments, exit codes, and exact stdout/stderr contracts. This file explains operational semantics, path resolution, scenario selection, and surrounding mechanics. Keep it synchronized with live help.

## Composing the spawn / send prompt

Before pressing enter on `tm spawn --prompt` or `tm send --prompt`, audit the prompt against both checklists below. Teammates default to behaving reasonably; the failure mode is the dispatcher either omitting a fact the teammate cannot infer (the first checklist) or adding noise that hobbles or misleads it (the second).

### Include in every prompt

The four pieces of information a teammate cannot derive from its own checkout — supply them, then stop:

1. **Intent.** The goal and *why* it matters, not the steps. The teammate plans the steps. A step-by-step recipe anchors the teammate to your preconception of the work and stops it from noticing a better path.
2. **Target branch and any PR/MR anchor.** Name the branch you want the teammate working on so it can verify and self-correct if it ended up somewhere else; name the related PR/MR number when one is relevant, since the teammate has no way to derive that from its checkout. State the branch as expectation ("work on `feat/foo`"), not as pre-fetched observation ("current branch is `feat/foo`") — the teammate's own `git status` is the ground truth, and an observed-state snapshot in the prompt risks being stale by the time the teammate reads it.
3. **Hard context.** Boundary conditions the user actually stated, prior decisions that bound the search space, the symptom you observed — load-bearing facts only.
4. **Deliverable shape.** What kind of artifact you want back: a verdict, a PR/MR, a changeset, a written report, a set of file edits, a one-line answer. Without this, teammates sometimes return the wrong artifact shape.

### Keep out of every prompt

1. **Keep the prompt minimal.** Aim for roughly the length and shape the user would type if they were dispatching the task themselves: a one-line business request plus only the conventions the teammate cannot infer (an opaque external ID, a required output channel such as a Feishu document). Stop there. A teammate handed a one-line task picks its own investigative path; a teammate handed a checklist anchors to your preconception of what matters and stops exploring. Common noise to keep out: a list of sub-questions ("cover these six points"); reminders of behavior the teammate does by default (read before edit, use `advisor` when stuck, do not fabricate); generic exhortations ("be careful", "double-check"). If the draft exceeds about ten lines, audit each line against "would the teammate not otherwise know this".

2. **Do not invent restrictions.** Skip "don't `advisor`", "don't open a new branch", "don't `grep` X" unless you have a concrete justification: the restricted action has demonstrably caused a foot-gun on this exact task; or it has a concrete cost the teammate cannot see (CI is already running on this commit); or the user explicitly said so. Restating something you are worried about is not a valid reason — it just removes the teammate's escalation channels right when it needs them.

3. **Do not fabricate the user's decisions.** Never write "user decided X" / "the user picked Y" / "the user said to do Z" in a teammate prompt when the user has not actually said that. Vague user input like "explore it" / "spin it up and see" / "go ahead" does not authorize you to pick an option from a multi-choice list on the user's behalf and forward it as a settled decision — pass the fuzziness through to the teammate, and let it raise the clarifying question by ending its turn with text (every teammate spawns with `AskUserQuestion` disabled, so a question surfaces as plain reply). Acid test: would a recording of the user's last few messages show them saying the words you are about to attribute to them? If not, forward the open question to the teammate and let it choose (or report back before acting), or ask the user one short clarifying question.

4. **Hand the teammate the symptom, not your theory.** When the dispatcher has a hypothesis about what's wrong in a sibling repo, the prompt should carry the symptom — and any concrete evidence you gathered — not the guess at the cause. "`/auth/callback` resets the session and the user lands back on `/login`" beats "the session cookie is probably missing `Secure`, fix it"; the second anchors the teammate to your hypothesis and may waste its turn defending it instead of looking. If your investigation produced real evidence (a stack trace, a log line, a diff fragment), include the evidence — just not the conclusion you drew from it. An unverified hypothesis injected as a premise is exactly what the teammate has to detox before it can think.

5. **Do not write "ping dispatcher" / "report back to dispatcher".** The dispatcher is an interactive REPL, not a `tm send` target. Saying "ping dispatcher" gives the teammate an unresolvable instruction; the Codex driver interprets such lines literally and searches for the closest dispatcher-shaped target — typically the main-repo Claude teammate whose name matches the repo — and runs `tm send <main-repo-tm>` against it. That teammate's auto-mode then burns a turn auto-acknowledging the unsolicited message. End the teammate's prompt at "write the artifact at `<path>` and stop" or "open the PR and stop". The Stop hook plus the `run_in_background: true` task-completion notification deliver the report; no separate ping is needed.

6. **Do not paste repo file paths or "Read X first" hints.** When the target repo runs a progressive context-load mechanism (its own `CLAUDE.md`, a `.agents/`-style knowledge base, a `context-load` script wired into spawn), write the prompt as a natural business request in the repo's product terminology. The repo's own disclosure mechanism is more accurate and more current than any path snapshot the dispatcher carries; pasted paths go stale as the knowledge base evolves, and a stale hint actively makes the teammate worse than no hint at all. If you genuinely need to point at a session-local artifact (a `/tmp/foo.md` you just wrote, a PR URL you just opened), that is fine — it is current state, not a knowledge-base path.

## The wait phase

`tm spawn --prompt`, `tm send`, `tm wait`, `tm resume --prompt`, and `tm ask` can block for a full model turn. Run them with `run_in_background: true` on the Bash tool so the dispatcher stays free; the harness fires a task notification when the verb returns.

Claude sync paths block until the teammate's next Stop hook fires (`--timeout 1800` default). Persistent Codex sync paths use the Codex driver, print the final assistant text on stdout, and write the raw Turn JSON to `/tmp/teammate-codex/<name>/last-turn.json`; read it with `tm last <name> --verbose` when needed. `--pane-quiet` is rejected on Codex targets. `tm ask` prints one ephemeral Turn JSON and releases the borrowed daemon.

## Exit codes for sync verbs

`tm spawn --prompt`, `tm send`, `tm wait`, and `tm compact` use the same high-level split:

- **`0`** — the reply or completion signal landed within `--timeout`; stdout contains the reply text or verb-specific success line. `tm ask` is the Codex exception that still prints an ephemeral Turn JSON.
- **`124`** — sync wait expired and the teammate is still running. Do not respawn; the teammate name is still taken. Collect the late result with `tm wait <name>` for Claude, or retry the relevant Codex wait/send flow after checking state.
- **`1`** — true failure: no teammate, missing sid/thread marker, broken send path, invalid repo/name, or the command was rejected.

Read stderr before deciding the next step; timeout paths name the recovery verb when one applies.

## Current-state command rules

- For reload fan-out across teammates, use `tm reload --all` or `tm reload <name>...`.
- For externally driven Claude turns (Remote Control web UI, mobile, the teammate's own sub-agents), collect the next reply with `tm wait <name> --fresh`; for Codex daemon turns, use `tm wait <name>`.
- For stopping a teammate, use `tm kill <name>`; it clears the matching on-disk state for that engine.

## Dispatcher-facing details on Claude spawn

- **Remote Control URL.** The teammate's startup banner prints its Remote Control URL; read it from `tm status <name>` and record it in the ledger at spawn time so the user has a direct channel to that teammate.

## Persistent Codex daemon teammates

Spawn persistent Codex explicitly:

```bash
tm spawn <path> --engine codex
```

Key differences from the Claude path:

- Codex teammates are daemons under `/tmp/teammate-codex/<name>/`, not tmux sessions.
- The name itself has no engine meaning; `codex-reviewer` is still a Claude teammate unless `--engine codex` is present.
- `<path>` is the spawn positional — the directory the daemon runs in, resolved relative to the dispatcher dir. Nested paths such as `web-project/flow-web-monorepo` are accepted.
- The flat `<name>` identifier (auto-generated as `<path-leaf>-<rand4>` or set with `--name`) composes the daemon registry and socket path under `/tmp/teammate-codex/<name>/`.
- `tm send <name> --prompt "..."` writes or resumes the daemon's persistent thread, prints final assistant text on stdout, and reports `sent` / `sid` / `ctx` / `raw` status lines on stderr.
- `tm kill <name>` reaps the daemon and registry directory instead of killing a tmux session.

Use this path when the user needs a named Codex teammate or resumable Codex thread. Use `tm ask` for throwaway Codex one-shots.

## Codex pool one-shots: `tm ask`

`tm ask "<prompt>"` borrows one alive idle Codex daemon, starts a fresh ephemeral thread, runs the prompt, prints the Turn JSON to stdout, and releases the daemon. It does not pollute the daemon's persistent conversation thread.

Preconditions and failures:

- At least one Codex daemon must already exist (`tm spawn <path> --engine codex`).
- If every recorded daemon is dead, run `tm doctor` to reap stale state or spawn a new daemon.
- If every alive daemon is borrowed, retry later or spawn one more daemon.

## Two reflexes to avoid

- **Don't `tm spawn` then immediately `tm send`** for a bootstrap. `tm spawn --prompt "..."` does both atomically in one call and returns the first-turn result on stdout.
- **Don't `cd <sibling-repo> && <cmd>`** to inspect a repo before dispatching to it. The Bash tool persists `cd` across invocations. Use `git -C <repo> <cmd>` for per-repo inspection, or `(cd <repo> && <cmd>)` as a subshell. Confirm `TM_DISPATCHER_DIR` with `tm doctor`.

## Resuming a prior task

If the user wants to continue a task whose teammate has died (dispatcher restarted, `tm kill`, Mac reboot), use `tm resume <name> <sid-or-thread-id>` with the id pulled from the active ledger or `tm history <name>`. See `inspect-and-resume.md`.

## Recording the task in the ledger

Every spawn that produces work worth tracking should append an entry to `active-dispatcher-tasks.md` at spawn time: sid/thread id when available, branch, intent, and artifacts you expect to fill later. Schema and entry shape live in `ledger-and-archive.md`. Skip this only for truly throwaway one-shot calls such as `tm ask` or a one-line "what's your branch?" probe.
