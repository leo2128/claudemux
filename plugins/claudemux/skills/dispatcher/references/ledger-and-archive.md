# Task ledger and archive (scenario reference)

Read this when you're appending a new active task to the ledger (at spawn time) or archiving a finished one (when the work hits a terminal state). Skip when you're just reading the ledger to answer "what's running" — that's a Read on `active-dispatcher-tasks.md` directly, no schema lookup needed.

## The two ledger files

Both live in the dispatcher's Claude Code memory directory — `~/.claude/projects/<encoded-cwd>/memory/`, where `<encoded-cwd>` is the dispatcher's `$PWD` with `/` and `.` replaced by `-` (auto-loaded entries are visible via `MEMORY.md`). This is **not** a directory inside the dispatcher repo itself; it is a path under `~/.claude/` managed by Claude Code. The ledger is also **not** in `<dispatcher-dir>/.workspace/`; the workspace holds personalization and ad-hoc artifacts, the ledger is structured state managed by the auto-memory system alongside `MEMORY.md`. Keep them separate.

| File | What it holds | When to read |
|---|---|---|
| `active-dispatcher-tasks.md` | In-flight tasks only, one `## Active` section. Small by construction. | **On dispatcher boot**, before any cross-task decision, and whenever the user asks "what's running" / "看看现在在跑啥". |
| `dispatcher-tasks-archive.md` | Closed tasks, compressed. | **Never on boot.** On demand only — when the user asks about a past task or you need history to make a decision. |

If `active-dispatcher-tasks.md` doesn't exist yet, create it from this shape:

```markdown
# Active dispatcher tasks

## Active

### t-20260518-1730-example [active]
- repo: /Users/foo/dev/example-repo
- branch: feature/example
- teammate: teammate-example-repo
- sid: 12345678-90ab-cdef-1234-567890abcdef
- intent: one short line describing what the user asked for
- artifacts: (empty until URLs appear)
- created: 2026-05-18T17:30:00+08:00
```

Let `tm archive` create `dispatcher-tasks-archive.md` when the first task closes; the verb seeds that file from its built-in template.

## Active entry schema

When you spawn delegated repo work (`tm spawn`, Agent teammate, or `claude -p`), append an entry to the `## Active` section. An active entry is working memory — keep whatever you need to resume the task: root-cause notes, option menus, resume instructions all belong here while the task is in flight. Required fields:

| Field | How to obtain |
|---|---|
| `id` | `t-<YYYYMMDD-HHMM>-<short-tag>` — short-tag is a 1-2 word slug of the intent |
| `repo` | The repo's absolute path (a sibling subdirectory under the dispatcher dir) |
| `branch` | `git -C <repo> branch --show-current` at spawn time |
| `teammate` | `teammate-<repo>` for Claude tmux teammates; Codex daemon name for Codex teammates; `<agent_id>@<team>` for Agent Teams teammates; short PID or none for `claude -p` |
| `sid` | The Claude session id or Codex thread id when available. For Claude tmux teammates, read `/tmp/teammate-<repo>.sid`; Claude continue/resume may update it after SessionStart. For live Codex teammates, read `/tmp/teammate-codex/<name>/thread` after a thread has started; if it is absent, record `(pending)` and fill it after the first `tm send` or explicit resume. For Agent Teams, use `n/a`. This is the id `tm resume <repo-or-name> <id>` consumes in a future dispatcher session. |
| `intent` | One short line — what the user actually asked for |
| `artifacts` | URLs to any Dev Task / MR / Feishu doc as they appear (start empty, fill later) |
| `created` | Timestamp at spawn |

## Archiving a finished task

Terminal state = MR merged / Dev Task closed / explicit "done" / teammate killed.

1. Compose the **outcome** — one or two lines: the conclusion plus key artifacts (commit SHAs, MR URL, Dev Task URL). This is the only part that needs your judgment; everything else is copied or stamped mechanically.
2. Pipe the outcome into `tm archive`:

   ```bash
   echo "<outcome text>" | tm archive t-20260515-1430-foo
   ```

   `tm archive` copies `repo` / `branch` / `intent` verbatim from the active entry, stamps today's date as `closed`, and carries over the active header's `[status]` tag — pass `--status '<tag>'` to change it (e.g. a task that was `[PAUSED]` and is now `done`). Prepends the compressed entry to the top of `dispatcher-tasks-archive.md` (newest first; creates that file from its shape if it doesn't exist), then deletes the full entry from `active-dispatcher-tasks.md`.

Run `tm archive --help` for the full flag/output contract.

## What goes in an archive entry — and what doesn't

An archive entry is a **pointer plus a conclusion**, not a knowledge store. The deep analysis lives on the task's branch, commit messages, and tracker record — the archive entry just points there.

If some analysis turns out to be durably reusable knowledge (not task-specific), promote it to its own `project` or `feedback` AutoMemory file instead of leaving it in the archive. The archive should stay scan-friendly.

Both files are plain markdown. Use Read/Edit for ledger inspection and in-place fixes; use `tm archive` for the active-to-archive move.
