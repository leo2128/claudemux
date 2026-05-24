# Dispatch a task to a repo (scenario reference)

Read this when you need to push work into a sibling repo — either bring up a new teammate to handle it, or hand a follow-up to an existing one. Skip when you only need to read teammate state (use `wait-and-readback.md`) or look up past sessions (`inspect-and-resume.md`).

The dispatcher dir is resolved as `${TM_DISPATCHER_DIR:-$PWD}` (see SKILL.md `tm overview`); `<repo>` below is the short name of a sibling subdirectory directly under it.

## Three primitives

| Situation | Verb |
|---|---|
| Fresh teammate AND a first task in one shot | `tm spawn <repo> --prompt "..."` (atomic bootstrap, prints first-turn reply on stdout) |
| Fresh teammate, no task yet | `tm spawn <repo>` (returns once the REPL signals SessionStart) |
| Existing teammate, send a new task and get the reply | `tm send <repo> --prompt "..."` (sync round-trip — send + wait for Stop + print reply on stdout) |

All three are background-execution candidates — see the wait phase contract below.

Run `tm spawn --help` / `tm send --help` for the full flag/output contract. The shipped help is the single source of truth; everything below explains the surrounding mechanics that `--help` doesn't cover.

## The wait phase — always background

`tm spawn --prompt` and `tm send` (default mode) both block until the teammate's next Stop hook fires (`--timeout 600` cap). That is potentially minutes. **Every such call MUST run with `run_in_background: true` on the Bash tool** so the dispatcher stays free to handle other work; the harness fires a task-notification when the verb returns, with the reply text already in stdout. Foreground waits block the dispatcher end-to-end for nothing — there is no upside.

Fire-and-forget is no longer a first-class CLI option. The two historical use cases are handled differently now: `/clear` before `tm kill` is redundant (kill already clears the on-disk markers); slash-command fan-out (e.g. `/reload-plugins`) is handled internally by `tm reload`. External-actor-driven turns (Remote Control web UI, mobile, cron) are collected with `tm wait --fresh`, since there is no `tm send --no-wait` to drive them.

## What `tm spawn` sets up under the hood

When you `tm spawn <repo>`:

1. **cwd** = `<dispatcher-dir>/<repo>`. The teammate's claude process is launched there via `tmux new-session -c`.
2. **CLAUDE.md exclusions.** Without help, claude's upward memory walk from `<dispatcher-dir>/<repo>` would pick up the dispatcher's own `CLAUDE.md` / `CLAUDE.local.md` as "project instructions" — but those are dispatcher-only and would confuse the teammate. `tm spawn` passes `--settings` with `claudeMdExcludes` for exactly those two files; the target repo's own `CLAUDE.md` still loads normally.
3. **Remote Control auto-registration.** The teammate's startup banner prints its own Remote Control URL (visible via `tm status <repo>`). The user can drive that teammate directly from claude.ai/code or mobile, in parallel with you.
4. **sid pre-generation.** `tm` generates a UUID and hands it to `claude --session-id <uuid>` so the sid is known the moment spawn returns; written to `/tmp/teammate-<repo>.sid`. Sets up the idle/.last machinery wait phase relies on (see `wait-and-readback.md`).
5. **`--task <slug>`** names the conversation `<repo>-<slug>` (visible in the prompt box / `/resume` picker / terminal title). Allowlist: `[a-z0-9]` + CJK Unified Ideographs (`--task 国际化` works). Without `--task`, a fresh spawn auto-names `<repo>-<rand4>`. Use this to stamp intent on the conversation so dispatcher-restart-then-resume can pick the right session.

## The two reflexes to avoid

- **Don't `tm spawn` then immediately `tm send`** for a bootstrap. `tm spawn --prompt "..."` does both atomically in one call and returns the first-turn reply on stdout. Two separate calls add a sleep + a second wait cycle for no benefit.
- **Don't `cd <sibling-repo> && <cmd>`** to inspect a repo before dispatching to it. The Bash tool persists `cd` across invocations, so the next `tm` call (or any dispatcher Bash work) inherits the drifted cwd. With `TM_DISPATCHER_DIR` set, `tm` itself stays correct; but `grep`/`find`/raw `git log` still see the drift. Use `git -C <repo> <cmd>` for per-repo inspection, or `(cd <repo> && <cmd>)` as a subshell so the parent's PWD never moves. Confirm `TM_DISPATCHER_DIR` is set via `tm doctor`.

## Resuming a prior task

If the user wants to continue a task whose teammate has died (dispatcher restarted, `tm kill`, Mac reboot), don't `tm spawn` a fresh session — that loses the prior context. Use `tm resume <repo> <sid>` instead, sid pulled from the active ledger (or `tm history <repo>` if the ledger entry is gone). See `inspect-and-resume.md`.

## Recording the task in the ledger

Every spawn that produces work worth tracking should append an entry to `active-dispatcher-tasks.md` at spawn time — the sid, branch, intent, and any artifact URLs you expect to fill later. Schema and entry shape live in `ledger-and-archive.md`. Skip this only for truly throwaway one-shot calls (e.g. a one-line "what's your branch?" probe).
