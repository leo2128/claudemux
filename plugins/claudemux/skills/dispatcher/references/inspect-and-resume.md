# Inspect history and resume a session (scenario reference)

Read this when you need to look back at a repo's past Claude sessions or Codex threads: pick the right id to resume, re-read what a teammate last said, or find a session/thread that was never recorded in the ledger. Skip when you are sending fresh work (`dispatch-task.md`) or waiting for a still-live turn (`wait-and-readback.md`).

## Three verbs and their boundary

| Verb | Scope | When to use |
|---|---|---|
| `tm last <name>` | Current live teammate only. Claude reads `/tmp/claude-idle/<sid>.last`; Codex reads the current thread's rollout JSONL. | Re-read the reply that `tm send` / `tm wait` already printed. |
| `tm history <name>` | Claude transcripts under the repo's project dir, and Codex rollouts under `~/.codex/sessions` filtered by cwd | Find a sid / thread id to resume; survey what has been done in this repo |
| `tm resume <name> [<sid-or-thread-id>]` | Starts a teammate process on a prior Claude session or Codex thread | Continue a task whose teammate died (dispatcher restarted, `tm kill`, Mac reboot) |

Run `tm last --help`, `tm history --help`, and `tm resume --help` for full flag/output contracts.

## Fleet snapshot: `tm states`

When several teammates are running and you want a one-shot "who's said what":

| Column | Meaning |
|---|---|
| `NAME` | Flat teammate identifier from `tm spawn` |
| `REPO` | Last path segment of the source repo (`identity.repo`) |
| `WORKTREE` | Worktree slug (`identity.worktreeSlug`), or `-` for `--no-worktree` teammates |
| `ENGINE` | `claude` or `codex` |
| `STATE` | `idle` / `busy` / `unknown`. Known Claude false-negative: TUI-only commands (`/help`, `/effort`, `/agents` dialogs, permission prompts) can fire no hooks, so STATE can read `idle` while the pane is blocked — use `tm status <name>` for ground truth. |
| `LAST` | Size and age of the last assistant reply, or `-` if no reply has ended yet |
| `PREVIEW` | First 50 chars of the last assistant reply, control chars stripped |

Claude `LAST` / `PREVIEW` come from `/tmp/claude-idle/<sid>.last`; Codex reads the current thread's rollout JSONL. `tm states` is cheap enough for fleet scanning and avoids scraping every pane.

## `tm history` modes

- **List mode**: `tm history <name>` prints a newest-first table. Current columns are `ENGINE`, `ID` (full canonical Claude sid or Codex thread id — the same string `tm resume` accepts; copy-paste it directly), `AGE`, `SIZE`, and `TOPIC`; a leading `*` marks the row matching the current live teammate's session/thread.
- **Detail mode**: `tm history <name> <sid-or-thread-prefix>` prints the full id, transcript/rollout path, size or line count, timestamps, ctx usage when available, full first user prompt, last assistant text up to 1500 chars, and a ready-to-paste `tm resume` command.

The Claude project dir is derived from the teammate's runtime cwd (the worktree path when a worktree is in use; otherwise the repo itself): every `/` and `.` becomes `-`, prepended with `$HOME/.claude/projects/`. Codex history is matched from rollout sessions by cwd.

## `tm resume` — prefer an explicit id

Two ways to call it:

- **With explicit id (preferred)**: `tm resume <name> <full-sid-or-thread-id>`. Pull the id from the task ledger or `tm history` detail output. Claude validates the transcript exists; Codex writes the thread id back to `/tmp/teammate-codex/<name>/thread` and calls `thread/resume`.
- **Without id**: `tm resume <name>`. Claude delegates selection to `claude --continue`; Codex asks the app-server for the latest thread for that cwd. Use only when the ledger entry is missing or you genuinely want the native/latest choice.

When no explicit id is supplied and both engines have resumable history for the cwd, `tm resume` refuses to guess. Pass `--engine claude|codex` or supply an explicit id.

Either way fails if a teammate for `<name>` is already alive (Claude tmux session or Codex daemon). `tm kill <name>` first if you intentionally want to replace it.

`--prompt "..."` sends a follow-up after relaunch (atomic, same shape as `tm spawn --prompt`). The resumed teammate keeps its original name.

## Picking up "that thing from yesterday"

User says: "继续昨天那个 X 任务" but the ledger entry is gone (archived, or was never appended).

1. Run `tm history <name>` and survey topics + ages.
2. Pick the row whose `TOPIC` matches what the user described.
3. Run `tm history <name> <id-prefix>` for detail; confirm via the full first prompt and last assistant text.
4. Use the detail output's ready-to-paste `tm resume <name> <full-id>` line.

## Resuming with a caller-supplied sid: verify subject first

When the user hands the dispatcher a sid or thread-id with a phrase like "this is the X result, take over the scheduling", do not decide what "X" means from whatever is most contextually salient in the current chat (a PR the dispatcher just opened, a task the dispatcher just finished). The dispatcher did not witness the resumed conversation, so the actual content of that session — not the local chat's loudest event — is the authority on what it was about.

After `tm resume <name> <sid>`, verify the subject via at least one of:

- **`tm last <name>`** — usually names the subject when a `.last` file exists.
- **Check the suspected target on the side** — `gh pr view <suspected-PR> --json reviews,comments`; if the resumed session was a review and the PR you assumed has empty reviews/comments, you assumed wrong.
- **Ask the user one line** — the cost of a clarifying reply is much lower than the cost of dispatching invented work to a downstream teammate.

These three checks cover this case; pick whichever is fastest for the situation. Only after one of them lines up with your understanding of the subject should you brief the teammate.

The first turn sent to the resumed teammate should not contain a confident statement about the subject ("you reviewed PR #N"). Ask the teammate to surface its existing conclusions first ("summarize what you concluded in this session in dispatcher-friendly format"), and let its summary establish the subject — that way a wrong subject manifests as a push-back, not as invented compliance.

## Foot-gun: polling history by prompt-echo

If you build a custom wait around `tm history` or `tm poll`, match expected result keywords (`merged`, `Cancelled`, anticipated error codes), never words from the prompt you just sent. The prompt itself appears in the user turn, so prompt-word grep returns instantly.

## Boundary recap

- `tm last` is current-live only; it dies once the teammate is killed unless the engine can resolve the current thread.
- `tm history` is the on-disk view; it survives kills and includes past sessions/threads.
- `tm resume` is state-mutating; it starts a process and claims the teammate name. `tm history` is read-only.
