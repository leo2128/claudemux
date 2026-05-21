# Component: the `dispatcher` skill

The `dispatcher` skill is the operations manual the dispatcher session loads
before any teammate operation. It turns a natural-language request ("派一个
teammate 去 repo-a 跑测试") into the right `tm` verb and delegation form.

## Files

| Path | Audience | Role |
|---|---|---|
| [`skills/dispatcher/SKILL.md`](/plugins/claudemux/skills/dispatcher/SKILL.md) | model | Always-loaded skeleton: scope check, delegation-form table, `tm` overview, a scenario routing table, shared invariants |
| `skills/dispatcher/references/*.md` | model, on demand | One file per scenario — the detailed flow for that scenario only |
| [`templates/CLAUDE.md.template`](/plugins/claudemux/templates/CLAUDE.md.template) | model, always loaded | Copied into the dispatcher directory by `/claudemux:setup`; the dispatcher's durable identity + routing memory |
| [`commands/setup.md`](/plugins/claudemux/commands/setup.md) | human → model | Body of the `/claudemux:setup` slash command — the guided onboarding flow |
| [`scripts/setup.sh`](/plugins/claudemux/scripts/setup.sh) | executable | The dependency-check + CLAUDE.md-seed + settings step `/claudemux:setup` runs |

## SKILL.md is a skeleton, references hold the steps

`SKILL.md` deliberately stays small (~96 lines). It does **not** contain
per-scenario steps; it contains a routing table that maps the user's intent
to one `references/<scenario>.md`. Each reference is self-contained — the
agent reads exactly the one that applies. The references:

| Reference | Scenario |
|---|---|
| `dispatch-task.md` | Push work into a repo via a tmux teammate (the default) |
| `sibling-memory.md` | Compose a prompt that quotes sibling-repo state (`tm mem`) |
| `wait-and-readback.md` | Wait for a turn an external actor drove; pane-quiet blind spot |
| `inspect-and-resume.md` | Read `tm states`; look up / resume past sessions |
| `compact-a-teammate.md` | Check or compact a teammate's context window |
| `ledger-and-archive.md` | Append / archive the dispatcher task ledger |
| `agent-teams.md` | Spawn an Agent Teams teammate instead of a tmux one |
| `sid-rotation.md` | Diagnose `.sid` drift or a stuck spawn |

This skeleton/reference split was a size cut — see
[the dispatcher SKILL.md split](https://github.com/excitedjs/claudemux/commit/dd94785) (commit `dd94785`).
When adding a scenario, add a reference and a routing-table row; do not
inline steps into `SKILL.md`.

## Audience boundaries (binding — from repo `CLAUDE.md`)

- `SKILL.md` **frontmatter** is model-facing routing metadata: describe
  *when* the skill is relevant. Keep behavior in the body.
- `SKILL.md` **body** and the references are model-facing operational
  guidance. Assume the future agent has no prior conversation context: give
  complete steps with the reason that makes each step necessary.
- `CLAUDE.md.template` is **always-loaded** dispatcher memory. Keep it short
  and durable — identity, routing boundaries, stable rules. Long protocols
  belong in the skill, not the template.
- `commands/setup.md` **body** runs only after the human invokes
  `/claudemux:setup`. Write it as an execution guide for that one command.

## Three delegation forms

The skill picks one of three ways to push work outward — chosen once, up
front:

| Form | Pick when |
|---|---|
| `claude -p` headless | One-shot repo task that finishes in one delegated turn |
| `Agent` teammate (Agent Teams) | Parallel work across repos sharing a task list |
| `tmux` teammate (`tm spawn`) | Long-running work needing a real REPL, its own cron, or a Remote Control session |

`CronCreate` fires reliably **only inside an interactive TUI REPL** — the
dispatcher itself, or a tmux teammate. `claude -p` and Agent Teams teammates
accept the create call and then never fire. This empirical fact drives the
"keep cron on the dispatcher" rule.

## Editing rule

`SKILL.md` is a feature-class path: a change to it requires a changeset
fragment in the same commit (see
[components/repo-tooling.md](/.agents/components/repo-tooling.md)). The
references are plain `*.md` and are exempt.

## See also

- [components/tm.md](/.agents/components/tm.md) — the verbs the skill drives.
- [components/optimize-skill.md](/.agents/components/optimize-skill.md) — the companion self-review skill.
