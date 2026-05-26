---
name: optimize
description: Periodic self-review of the dispatcher's own conversation history. Surfaces uncaptured corrections, recurring foot-guns, and drifted conventions, and promotes each finding into the right carrier (CLAUDE.md, project memory, or local dispatcher notes). Trigger when the user asks to "复盘 / 自我反省 / 派活流程审查 / review dispatcher / optimize dispatcher / let dispatcher self-reflect / /claudemux:optimize", or when a scheduled cron callback fires the periodic review.
context: fork
---

# Dispatcher Self-Optimize

Periodically scan the dispatcher's own conversation history, surface uncaptured corrections / foot-guns / conventions, and promote them into the right carrier (CLAUDE.md, project memory, or local dispatcher notes). Runs in a forked context (`context: fork` frontmatter) so the log analysis stays out of the parent dispatcher session.

## Where this skill writes

This skill runs in the dispatcher's `$PWD` (the parent of sibling repos — no config file, no env override) and writes only inside three roots derived from it:

- **The dispatcher's `CLAUDE.md`** (seeded by `/claudemux:setup`).
- **The dispatcher's `.claude/local-dispatcher-notes.md`** — user-owned, free-form. `.claude/` may not exist yet on a fresh dispatcher; `mkdir -p .claude` before the first write.
- **The project's AutoMemory directory** — Claude Code stores it at `~/.claude/projects/<encoded-cwd>/memory/`, where `<encoded-cwd>` is `$PWD` with both `/` and `.` replaced by `-`.

If a write would land anywhere else, treat it as a bug and stop. The plugin install directory (this skill's own files) is read-only; never try to self-edit.

`${CLAUDE_PLUGIN_ROOT}` is injected by Claude Code into the environment of plugin-defined commands, hooks, and skill bodies — including this one — so `Bash` calls from inside this skill body can read `${CLAUDE_PLUGIN_ROOT}/skills/dispatcher/SKILL.md` or `${CLAUDE_PLUGIN_ROOT}/bin/tm` directly. Don't assume it is set in unrelated subshells.

## Scope — what's in, what's out

In scope (read AND modify):

| Carrier | Where |
|---|---|
| Project CLAUDE.md | the dispatcher's `CLAUDE.md` (resolves under `$PWD`) |
| Project memory | any `*.md` file inside the AutoMemory directory |
| Local dispatcher notes | the dispatcher's `.claude/local-dispatcher-notes.md` (user-owned, free-form) |

In scope (propose only — never write):

- **New skill proposals** — when a finding clusters enough material to warrant a dedicated skill, write the proposal into the final report (cluster summary + suggested name + draft trigger description) and let the user create the skill themselves via `skill-creator` or whatever flow they prefer. Don't decide where it should live; the user picks project-scoped, user-scoped, or a separate plugin.

In scope (read only — signal source):

- The dispatcher's own JSONL transcripts (the scanner does the lookup; you don't normally Read these directly).

Out of scope — never touch:

- This plugin's install directory (`${CLAUDE_PLUGIN_ROOT}` — the dispatcher / optimize skills themselves are read-only).
- Global `~/.claude/CLAUDE.md` and global skills under `~/.claude/skills/`.
- AutoMemory directories of sibling repo projects (each repo has its own encoded directory under `~/.claude/projects/`).
- Teammate session jsonls inside those projects.
- Any file outside the three "in scope (modify)" roots listed above.

Global promotion (machine-wide CLAUDE.md / global skills) is intentionally out of scope here. If a finding genuinely warrants a global rule, surface it in the final report and let the user decide; never write outside the three "in scope (modify)" roots.

## Execution flow

### 1. Generate dispatcher session logs

Run the bundled scanner, which converts the dispatcher's recent JSONL transcripts into readable MD logs:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/skills/optimize/scripts/scan-dispatcher.sh" 7 /tmp/dispatcher-optimize-logs
```

Arguments: `[days=7] [output_dir=/tmp/dispatcher-optimize-logs]`. The scanner uses `$PWD` (physical path) to locate `~/.claude/projects/<encoded>/` — Claude Code encodes each project's cwd as the directory name, so that single directory contains EXACTLY the dispatcher's own sessions (per-repo teammate sessions live under different encoded dirs, so there's no cross-project leakage). Run it from the dispatcher session. Use the default 7-day window unless the user requests a different one ("the last 24 hours" → 1, "the last month" → 30).

The scanner emits a `STATUS:` line on stdout. Grep it and branch — these three states have **different** meanings for the user, so do not collapse them:

| STATUS line | Exit code | What it means | What to do |
|---|---|---|---|
| `STATUS: no-project-dir` | 2 | Claude Code has never recorded a session for `$PWD`. The user installed claudemux but hasn't actually run `claude` from this directory yet. | Stop the skill. Report: "this dispatcher dir has no recorded sessions yet — start a dispatcher with `tmux new-session -s dispatcher -c <DISPATCHER_DIR>` and run `claude` inside it, use it for a while, then re-run optimize." |
| `STATUS: no-signal` | 0 | Project dir exists, but no jsonl in the look-back window has ≥ `MIN_TURNS=2` user turns. | Stop the skill. Report: "no recent activity to review (last <days> days)." Suggest widening (`days=30`) or coming back later. |
| `STATUS: ok` | 0 | At least one session log was written. | Proceed to step 2. |

Capture stdout to grep for STATUS, e.g.:

```bash
SCAN_OUT=$(bash "${CLAUDE_PLUGIN_ROOT}/skills/optimize/scripts/scan-dispatcher.sh" 7 /tmp/dispatcher-optimize-logs)
echo "$SCAN_OUT"
STATUS=$(echo "$SCAN_OUT" | grep '^STATUS:' | tail -1)
```

Prerequisite: `jq` on `PATH` (standard on macOS via `brew install jq`, on Debian/Ubuntu via `apt-get install jq`). No other external dependencies — the scanner is self-contained bash + jq.

### 2. Read all the signal sources

In the forked context, read these in parallel where possible:

- Every `*.md` file in `/tmp/dispatcher-optimize-logs/` (the session logs from step 1).
- The dispatcher's `CLAUDE.md`.
- `${CLAUDE_PLUGIN_ROOT}/skills/dispatcher/SKILL.md` (dispatcher skill body — read-only, but you need it to know what's already documented).
- `${CLAUDE_PLUGIN_ROOT}/bin/tm` (the helper script — read-only).
- The dispatcher's `.claude/local-dispatcher-notes.md`, if present (probe with `test -f` first; absent file is not an error).
- The `MEMORY.md` index inside the AutoMemory directory, if present.
- Every `*.md` file linked from `MEMORY.md`.

You need both sides — the lessons in the logs and the current state of the carriers — to decide what's already captured and what's not.

### 3. Identify candidate findings

For each log, look along these axes:

| Axis | Example |
|---|---|
| User correction not yet captured as a feedback memory or CLAUDE.md rule | "stop doing X" said once, no memory written |
| Recurring foot-gun the dispatcher hit more than once | Cron fired the wrong way; teammate spawn missed a step |
| Ledger drift | Active entry whose teammate no longer exists; intent line gone stale |
| Skill instruction that should have triggered but didn't | dispatcher skill description failed to match a clear-cut request |
| Implicit correction at rollback markers (`↩` in the log) | User rolled back and retried — what was the implicit fix? |
| Convention stated in conversation but not encoded anywhere | "I prefer X" mentioned a few times, no rule |
| Repeated work pattern that would benefit from a `tm` subcommand or helper | Same 3-line bash incantation typed across sessions |

For each candidate, write a one-line summary plus one or two log excerpts as evidence. If you can't point at evidence, don't promote it.

### 4. Apply the decision tree

Use `references/decision-tree.md` (in this skill) to pick the carrier for each finding. Summary:

| Carrier | Auto-apply | Requires user confirmation |
|---|---|---|
| Project memory file (new/edit) | yes | wholesale deletion of an existing file |
| Project memory (MEMORY.md index update) | yes | — |
| Local dispatcher notes — small addition (≤ 5 lines, append) | yes | rewrites, deletions |
| Dispatcher CLAUDE.md — small addition (≤ 3 sentences, existing section) | yes | rewrites, deletions, larger additions |
| Plugin-level skill change (`dispatcher/SKILL.md` or `bin/tm`) | NEVER auto-apply | always propose a diff for the user to apply manually; the plugin install dir is read-only |
| New skill | NEVER auto-apply | always propose in the report; let the user decide where it should live and create it themselves |

The "auto-apply" entries write directly. The "requires confirmation" entries are collected into the final report as proposals with concrete diffs the user can approve in one turn. See `references/decision-tree.md` for the exact auto-apply boundaries (e.g. which memory operations qualify as "routine cleanup", how to phrase a propose-only diff).

Before applying any change, dedup: if the rule is already in CLAUDE.md, the dispatcher skill, or the local notes file, don't re-add. If a memory already says the same thing, edit it in place instead of creating a duplicate.

Write user-specific findings to local dispatcher notes, **not** to the dispatcher skill body. The skill body is shipped inside the claudemux plugin install dir, which is read-only and gets overwritten on plugin update; the notes file is user-owned and survives upgrades. The dispatcher skill's body already points at the notes file, so additions there are reachable by future dispatcher sessions automatically.

### 5. Post-promotion cleanup

When a memory's content has been absorbed into CLAUDE.md or the local dispatcher notes, delete the memory file and remove its line from `MEMORY.md`. The whole point of promotion is that the lesson lives in a more efficient carrier — leaving the original around defeats the purpose. (Anti-pattern: "I promoted it but kept the memory too" → next pass sees it again.)

### 6. Clean up scratch state

```bash
rm -f /tmp/dispatcher-optimize-logs/*.md
```

### 7. Return a concise report

Output to the parent context (the dispatcher) a short structured summary, NOT a dump of everything you read. Format:

```
# Dispatcher review (<date>, <N> sessions over last <D> days)

## Auto-applied
- [<carrier>] <one-line change summary>
- [memory:new] feedback-<topic>.md — <why>
- [local-notes] added foot-gun bullet on X
...

## Awaiting your confirmation
### <P0 — most important first>
<finding>, evidence: <one or two log excerpts>
Proposed change: <concrete diff or text snippet>
Carrier: <which file>

### <P1>
...

## Observations not yet promoted
<short notes on patterns you saw but didn't have enough density to promote yet>
```

Keep the report under ~200 lines — the user reads this, not the underlying logs. If you end up with more than 8 confirmation-pending items, list P2 entries as one-line titles only (no proposal body) so the report stays scannable; P0 and P1 always get the full proposal body.

If any step in this skill errors (jsonl corruption, a `Read` that fails, a Bash exit ≠ 0), return a one-line failure summary to the parent context naming the failing step — never swallow the error and continue silently. The parent dispatcher needs to know the review did not complete so it can surface that to the user.

## Scheduling

Once the user has confirmed the skill works manually, schedule it via `CronCreate` from the dispatcher (CronCreate only fires inside an interactive TUI REPL — the dispatcher session and `tm`-spawned Claude tmux sessions both qualify; `claude -p` and Agent Teams subagents accept the call but silently never fire):

```
CronCreate({
  prompt: "Run /claudemux:optimize on the last 7 days of dispatcher conversations. This is the scheduled weekly review.",
  schedule: "23 4 * * 1"   // every Monday at 04:23 — off-minute to avoid fleet aliasing
})
```

The dispatcher gets the callback as a turn; the prompt triggers this skill by description match; the skill body runs in its forked context; the parent dispatcher only sees the final report.

Avoid `:00` and `:30` minute marks — the platform-wide fleet aliases there. Pick a quirky minute (`23`, `47`, `7`).

Recurring `CronCreate` jobs auto-expire after 7 days. If you want this running indefinitely, the callback prompt can `CronCreate` itself again at the end of its run, or the user re-arms it weekly.

## Compatibility with manual invocation

`/claudemux:optimize` works as a one-shot manual run too — the user can ask anytime. Same flow, no behavioral difference between manual and cron-triggered.

When asked to do a partial run (e.g., "only review the last 24 hours" or "only look at task ledger drift"), narrow step 1's `days` arg or skip irrelevant axes in step 3 — the rest of the flow is unchanged.
