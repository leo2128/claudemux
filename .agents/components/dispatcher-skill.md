# Component: the `dispatcher` skill

The `dispatcher` skill is the operations manual the dispatcher session loads
before any teammate operation. It turns a natural-language request ("派一个
teammate 去 repo-a 跑测试") into the right delegation form and `tm` verb.

## Files

| Path | Audience | Role |
|---|---|---|
| [`skills/dispatcher/SKILL.md`](/plugins/claudemux/skills/dispatcher/SKILL.md) | model | Always-loaded skeleton: scope check, `tm` overview, scenario routing, shared invariants |
| `skills/dispatcher/references/*.md` | model, on demand | One file per scenario — the detailed flow for that scenario only |
| [`templates/CLAUDE.md.template`](/plugins/claudemux/templates/CLAUDE.md.template) | model, always loaded | Copied into the dispatcher directory by `/claudemux:setup`; the dispatcher's durable identity + routing memory |
| [`commands/setup.md`](/plugins/claudemux/commands/setup.md) | human → model | Body of the `/claudemux:setup` slash command — the guided onboarding flow |
| [`scripts/setup.sh`](/plugins/claudemux/scripts/setup.sh) | executable | The dependency-check + CLAUDE.md-seed + settings step `/claudemux:setup` runs |

## SKILL.md is a skeleton, references hold the steps

`SKILL.md` deliberately stays small (around 100 lines). It does **not** contain
per-scenario steps; it contains a routing table that maps the user's intent
to one `references/<scenario>.md`. Each reference is self-contained — the
agent reads exactly the one that applies. The references:

| Reference | Scenario |
|---|---|
| `dispatch-task.md` | Push work into a Claude tmux teammate, persistent Codex daemon teammate, or Codex pool one-shot |
| `sibling-memory.md` | Compose a prompt that quotes sibling-repo state (`tm mem`) |
| `wait-and-readback.md` | Wait for a turn an external actor drove; pane-quiet blind spot |
| `inspect-and-resume.md` | Read `tm states`; look up / resume past Claude sessions and Codex threads |
| `compact-a-teammate.md` | Check or compact a Claude teammate's context window |
| `ledger-and-archive.md` | Append / archive the dispatcher task ledger |
| `agent-teams.md` | Spawn an Agent Teams teammate (legacy reference — see SKILL.md for why this form is no longer surfaced as a dispatcher delegation option) |
| `sid-rotation.md` | Diagnose `.sid` drift or a stuck Claude spawn |

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

## Delegation invariant

The dispatcher orchestrates teammates exclusively through `tm`. Agent Teams
and raw `claude -p` are intentionally not surfaced as dispatcher delegation
forms; routing every teammate through the same `tm` verbs is what makes the
ledger, identity record, and state-tracking machinery cover every teammate
the same way. The scenario-routing table in `SKILL.md` is the up-to-date
list of `tm` verbs and the reference each one belongs to.

## Editing rule

`SKILL.md` is a feature-class path: a change to it requires a changeset
fragment in the same commit (see
[components/repo-tooling.md](/.agents/components/repo-tooling.md)). The
references are plain `*.md` and are exempt.

## See also

- [components/tm.md](/.agents/components/tm.md) — the verbs the skill drives.
- [components/optimize-skill.md](/.agents/components/optimize-skill.md) — the companion self-review skill.
