# Inspect history and resume a session (scenario reference)

Read this when you need to look back at a repo's past Claude sessions — pick the right sid to resume, re-read what a teammate last said, or find a session that was never recorded in the ledger. Skip when you're sending fresh work (use `dispatch-task.md`) or waiting for a still-live turn (`wait-and-readback.md`).

## Three verbs and their boundary

| Verb | Scope | When to use |
|---|---|---|
| `tm last <repo>` | Current live teammate only — reads the in-memory hook file `/tmp/claude-idle/<sid>.last` | Re-read the reply that `tm send` / `tm wait` already printed (those are one-shot — stdout is gone once you've consumed it) |
| `tm history <repo>` | Any `*.jsonl` on disk under the repo's project dir — includes killed sessions, never-tracked sessions, everything | Find a sid to resume; survey what's been done in this repo |
| `tm resume <repo> [<sid>]` | Re-attaches a tmux session to a prior jsonl | Continue a task whose teammate died (dispatcher restarted, `tm kill`, Mac reboot) |

Run `tm last --help` / `tm history --help` / `tm resume --help` for full flag/output contracts.

## Fleet snapshot: `tm states`

When several teammates are running and you want a one-shot "who's said what":

| Column | Meaning |
|---|---|
| `REPO` | Short repo name (= tmux session minus `teammate-` prefix) |
| `SID` | First 8 chars of the session id (kept fresh across `/clear` by the SessionStart hook — see `sid-rotation.md`) |
| `BUSY` | `yes` if `/tmp/claude-idle/<sid>.busy` exists. The plugin's `on-busy.sh` hook touches that file on UserPromptSubmit / UserPromptExpansion / PreToolUse / PreCompact, and `on-stop.sh` removes it on Stop / StopFailure / PostCompact / SessionEnd. **Known false-negative**: purely-TUI commands (`/help`, `/effort`, `/agents` dialogs, permission prompts) fire zero hooks, so BUSY can read `no` while the pane actually shows a blocking dialog. Use `tm status <repo>` if you need ground truth. |
| `LAST` | Byte count and age of `<sid>.last`, or `-` if no turn has ended yet |
| `PREVIEW` | First 50 chars of `<sid>.last`, control chars stripped |

`LAST` and `PREVIEW` read the same `/tmp/claude-idle/<sid>.last` file `tm last` does — written by the Stop hook (full machinery in `wait-and-readback.md`). `BUSY` is a stat() of one file — cheap, no pane scraping. The three columns together answer "who's working right now" and "what did each teammate last say" without scraping each pane individually.

## `tm history` modes

- **List mode**: `tm history <repo>` prints a newest-first table — `SID` (first 8 chars), `AGE` (relative mtime), `SIZE`, `TOPIC` (first user prompt, truncated to 60 chars). A leading `*` marks the row whose sid matches the current live teammate (`/tmp/teammate-<repo>.sid`). Use this to pick a session.
- **Detail mode**: `tm history <repo> <sid-or-prefix>` (8+ char prefix is fine; ambiguous prefixes are rejected with the candidate list) prints full sid + jsonl path/size/line count + created/last-seen timestamps + ctx usage (same calculation as `tm ctx`) + the full first user prompt + the last assistant text up to 1500 chars + a ready-to-paste `tm resume <repo> <full-sid>` line.

The project dir is derived from the repo's physical cwd: every `/` and `.` in `<dispatcher-dir>/<repo>` becomes `-`, prepended with `$HOME/.claude/projects/`. That's the same encoding Claude Code itself uses, so `tm history` and the auto-memory writer always agree on which directory to read.

## `tm resume` — prefer ledger over auto-pick

Two ways to call it:

- **With explicit sid** (PREFERRED): `tm resume <repo> <full-sid>`. Pull the sid from the task ledger (`active-dispatcher-tasks.md` records the sid of every teammate it spawned — see `ledger-and-archive.md`). Validates the jsonl exists; rejects invalid UUIDs.
- **Without sid**: `tm resume <repo>`. Auto-picks the newest jsonl by mtime, prints a stderr warning. Use only when the ledger entry is missing or you genuinely want "whatever was last"; newest-by-mtime is rarely the session you actually meant — a long-idle teammate that just got a single ping has more recent mtime than the actively-worked one.

Either way fails if a teammate session for `<repo>` already exists (would conflict with the live tmux session). `tm kill <repo>` first if you really want to start over.

`--prompt "..."` sends a follow-up after a 3 s settle (atomic, same shape as `tm spawn --prompt`). `--task <slug>` relabels the resumed conversation.

## Picking up "that thing from yesterday"

User says: "继续昨天那个 X 任务" but the ledger entry is gone (archived, or was never appended).

1. `tm history <repo>` — survey topics + ages.
2. Pick the row whose TOPIC matches what the user described.
3. `tm history <repo> <sid-prefix>` for the detail — confirm via the full first prompt and last assistant text.
4. The detail output already contains a paste-ready `tm resume <repo> <full-sid>` line; use it.

## Foot-gun: polling history by prompt-echo

If you ever build a custom wait around `tm history` (e.g. "loop until the last assistant text contains 'merged'"), match against expected **result** keywords (`merged`, `Cancelled`, error codes you anticipate) — never against words from the prompt you just sent. The prompt itself appears in the user turn, so a grep on prompt-words returns instantly and the wait is meaningless. This rule applies to `tm poll` too.

## Boundary recap

- `tm last` is current-live only — fast, in-memory, but dies once the teammate is killed.
- `tm history` is the on-disk view — survives kills, includes everything.
- `tm resume` is the only state-mutating one in this trio — it starts a process and claims the tmux session name. `tm history` is read-only; it only *suggests* the resume command in its detail output.
