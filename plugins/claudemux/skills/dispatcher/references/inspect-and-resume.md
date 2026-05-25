# Inspect history and resume a session (scenario reference)

Read this when you need to look back at a repo's past Claude sessions or Codex threads: pick the right id to resume, re-read what a teammate last said, or find a session/thread that was never recorded in the ledger. Skip when you are sending fresh work (`dispatch-task.md`) or waiting for a still-live turn (`wait-and-readback.md`).

## Three verbs and their boundary

| Verb | Scope | When to use |
|---|---|---|
| `tm last <repo-or-name>` | Current live teammate only. Claude reads `/tmp/claude-idle/<sid>.last`; Codex reads the current thread's rollout JSONL. | Re-read the reply that `tm send` / `tm wait` already printed. |
| `tm history <repo-or-name>` | Claude transcripts under the repo's project dir, and Codex rollouts under `~/.codex/sessions` filtered by cwd | Find a sid / thread id to resume; survey what has been done in this repo |
| `tm resume <repo-or-name> [<sid-or-thread-id>]` | Starts a teammate process on a prior Claude session or Codex thread | Continue a task whose teammate died (dispatcher restarted, `tm kill`, Mac reboot) |

Run `tm last --help`, `tm history --help`, and `tm resume --help` for full flag/output contracts.

## Fleet snapshot: `tm states`

When several teammates are running and you want a one-shot "who's said what":

| Column | Meaning |
|---|---|
| `REPO` | Teammate name |
| `SID` | First 8 chars of the Claude session id or Codex thread id |
| `BUSY` | Claude: `/tmp/claude-idle/<sid>.busy`; Codex: daemon borrow/live-turn state. Known Claude false-negative: TUI-only commands (`/help`, `/effort`, `/agents` dialogs, permission prompts) can fire no hooks, so BUSY can read `no` while the pane is blocked. Use `tm status <repo>` if you need ground truth. |
| `LAST` | Size and age of the last assistant reply, or `-` if no reply has ended yet |
| `PREVIEW` | First 50 chars of the last assistant reply, control chars stripped |

Claude `LAST` / `PREVIEW` come from `/tmp/claude-idle/<sid>.last`; Codex reads the current thread's rollout JSONL. `tm states` is cheap enough for fleet scanning and avoids scraping every pane.

## `tm history` modes

- **List mode**: `tm history <repo-or-name>` prints a newest-first table. Current columns are `ENGINE`, `ID` (full canonical Claude sid or Codex thread id — the same string `tm resume` accepts; copy-paste it directly), `AGE`, `SIZE`, and `TOPIC`; a leading `*` marks the row matching the current live teammate's session/thread.
- **Detail mode**: `tm history <repo-or-name> <sid-or-thread-prefix>` prints the full id, transcript/rollout path, size or line count, timestamps, ctx usage when available, full first user prompt, last assistant text up to 1500 chars, and a ready-to-paste `tm resume` command.

The Claude project dir is derived from the repo's physical cwd: every `/` and `.` in `<dispatcher-dir>/<repo>` becomes `-`, prepended with `$HOME/.claude/projects/`. Codex history is matched from rollout sessions by cwd.

## `tm resume` — prefer an explicit id

Two ways to call it:

- **With explicit id (preferred)**: `tm resume <repo-or-name> <full-sid-or-thread-id>`. Pull the id from the task ledger or `tm history` detail output. Claude validates the transcript exists; Codex writes the thread id back to `/tmp/teammate-codex/<name>/thread` and calls `thread/resume`.
- **Without id**: `tm resume <repo-or-name>`. Claude delegates selection to `claude --continue`; Codex asks the app-server for the latest thread for that cwd. Use only when the ledger entry is missing or you genuinely want the native/latest choice.

When no explicit id is supplied and both engines have resumable history for the cwd, `tm resume` refuses to guess. Pass `--engine claude|codex` or supply an explicit id.

Either way fails if a teammate for `<repo-or-name>` is already alive (Claude tmux session or Codex daemon). `tm kill <repo-or-name>` first if you intentionally want to replace it.

`--prompt "..."` sends a follow-up after relaunch (atomic, same shape as `tm spawn --prompt`). `--task <slug>` relabels resumed Claude conversations; Codex resume uses thread ids.

## Picking up "that thing from yesterday"

User says: "继续昨天那个 X 任务" but the ledger entry is gone (archived, or was never appended).

1. Run `tm history <repo-or-name>` and survey topics + ages.
2. Pick the row whose `TOPIC` matches what the user described.
3. Run `tm history <repo-or-name> <id-prefix>` for detail; confirm via the full first prompt and last assistant text.
4. Use the detail output's ready-to-paste `tm resume <repo-or-name> <full-id>` line.

## Foot-gun: polling history by prompt-echo

If you build a custom wait around `tm history` or `tm poll`, match expected result keywords (`merged`, `Cancelled`, anticipated error codes), never words from the prompt you just sent. The prompt itself appears in the user turn, so prompt-word grep returns instantly.

## Boundary recap

- `tm last` is current-live only; it dies once the teammate is killed unless the engine can resolve the current thread.
- `tm history` is the on-disk view; it survives kills and includes past sessions/threads.
- `tm resume` is state-mutating; it starts a process and claims the teammate name. `tm history` is read-only.
