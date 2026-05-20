# Component: the `optimize` skill

`/claudemux:optimize` is a periodic self-review. It scans the dispatcher's
own recent conversation history, surfaces uncaptured corrections / recurring
foot-guns / drifted conventions, and promotes each finding into the right
carrier. It runs manually or on a `CronCreate` schedule.

## Files

| Path | Role |
|---|---|
| [`skills/optimize/SKILL.md`](/plugins/claudemux/skills/optimize/SKILL.md) | The skill body — 7-step execution flow |
| [`skills/optimize/scripts/scan-dispatcher.sh`](/plugins/claudemux/skills/optimize/scripts/scan-dispatcher.sh) | Self-contained bash + `jq` scanner: turns recent dispatcher JSONL transcripts into readable MD logs |
| `skills/optimize/references/decision-tree.md` | Which carrier a finding goes to, and the auto-apply boundaries |

## Forked context

`SKILL.md` frontmatter sets `context: fork` — the log analysis runs in a
forked context so it stays out of the parent dispatcher session. The parent
only ever sees the final structured report.

## What it may write — and what it must not

The skill writes only inside three roots, all derived from the dispatcher's
`$PWD` (there is no config file or env override):

| Carrier | Location |
|---|---|
| Dispatcher `CLAUDE.md` | seeded by `/claudemux:setup` under `$PWD` |
| Local dispatcher notes | `.claude/local-dispatcher-notes.md` under `$PWD` |
| Project memory | `~/.claude/projects/<encoded-cwd>/memory/*.md` |

Out of scope and never touched: the plugin install directory (the skill's
own files are read-only), global `~/.claude/CLAUDE.md`, global skills, and
sibling-repo AutoMemory directories. A write landing anywhere else is a bug.

## The scanner's three `STATUS:` outcomes

`scan-dispatcher.sh` emits a `STATUS:` line; the three values mean different
things and must not be collapsed:

| `STATUS:` | Meaning | Skill action |
|---|---|---|
| `no-project-dir` (exit 2) | Claude Code never recorded a session for `$PWD` | Stop; tell the user to run a dispatcher from this directory first |
| `no-signal` (exit 0) | Project dir exists but no jsonl has enough user turns in the window | Stop; report "no recent activity" |
| `ok` (exit 0) | At least one session log was written | Proceed to analysis |

The scanner locates the dispatcher's sessions by encoding `$PWD` the same
way `tm` does — `/` and `.` both replaced with `-`. That single encoded
directory holds exactly the dispatcher's own sessions; teammate sessions
live under different encoded dirs, so there is no cross-project leakage.

## Promotion discipline

When a finding is absorbed into a more efficient carrier (e.g. a memory's
content moves into `CLAUDE.md`), the skill deletes the original and removes
its `MEMORY.md` index line. Leaving the original behind defeats the point —
the next pass would re-surface it.

Plugin-level skill changes (`dispatcher/SKILL.md`, `bin/tm`) are **never**
auto-applied — the install dir is read-only; the skill proposes a diff for
the user to apply. User-specific findings go to the local notes file, never
into the shipped skill body, because the notes file survives plugin
upgrades and the skill body is overwritten by them.

## See also

- [components/dispatcher-skill.md](/.agents/components/dispatcher-skill.md) — the skill `optimize` reviews and proposes changes to.
- [components/tm.md](/.agents/components/tm.md) — `optimize` reads `bin/tm` to know what is already documented.
