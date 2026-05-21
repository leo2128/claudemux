# Contributing to the claudemux KB

This file explains how the `.agents/` knowledge base is organized, what
belongs in it, and the protocol for keeping it accurate. Read it before you
edit anything under `.agents/`.

## Objective

The KB exists to save a future agent **at least one round of wrong
exploration**. A good entry is:

- **High-leverage** — it changes a routing or design decision, not just a
  fact already obvious from one file.
- **Routed** — it tells the agent which component, script, or doc to open.
- **Checkable** — links and structure are stable, so `scripts/check.sh` can
  verify them.
- **Fresh** — it is updated in the same change that moves the thing it
  describes.

## Layout

| Path | Holds | Audience read pattern |
|---|---|---|
| `root.md` | Entry point: what claudemux is, repo layout, KB navigation | First file an agent reads |
| `CONTRIBUTING.md` | This file — KB rules and the knowledge-delta protocol | Before editing `.agents/` |
| `components/*.md` | One per component: what it owns, entry points, local foot-guns | When a task touches that component |
| `domains/*.md` | Cross-cutting contracts that span components | When a task crosses a component seam |
| `decisions/*.md` | Numbered decision records — context, decision, consequences | When you need the *why* behind a design |
| `research/*.md` | Frozen point-in-time research snapshots, indexed by `research/index.md` | When you need the legwork behind a decision |
| `rules/*.md` | Durable process rules for working in this repo | As referenced |
| `scripts/check.sh` | Structural self-check (broken links, orphan docs) | Run before finishing a KB change |

The KB does **not** mirror the repo's directory tree one-to-one. claudemux
is a bash/tmux orchestrator plus plugins, not a package monorepo, so
components are grouped by *what an agent works on* (the `tm` CLI, the hooks,
a skill), not by folder.

## Knowledge-delta protocol

Before you finish any non-trivial change, ask one question:

> Did this change move a component boundary, the cross-process file
> protocol, the `tm` verb set, hook event wiring, the plugin layout, or did
> it settle a decision a future agent could easily get wrong?

- **Yes** → update the matching KB document in the *same* change. A code
  change that silently outdates the KB is an incomplete change.
- **No** → do not pad the KB to look thorough. A local implementation tweak
  that leaves boundaries and entry points intact needs no KB edit.

### Typically YES

- A `tm` verb is added, removed, or its flags/output change.
- A new `/tmp` or `~/.claude/projects/` protocol file appears, or an
  existing one changes shape.
- A hook is bound to a different event, or a hook's marker behavior changes.
- A new component appears (e.g. a third plugin) or two components merge.
- A design choice is made that the next agent would otherwise re-litigate.

### Typically NO

- A bug fix inside one function with no contract change.
- A fact that is obvious from reading a single file or `tm <verb> --help`.
- A one-off debugging conclusion, a TODO, or in-progress scratch state.

## Hazard dispositions

A research document is a hand-off: the next agent acts on it without having
done the investigation. A **hazard** in that document — a constraint, trap, or
platform fact that breaks the product if mishandled — must not be able to
reach the end of the document and simply stop there. Every research doc
reconciles the hazards it raised to an explicit disposition, in a closing
`## Hazard dispositions` section. The reason and the full case are in
[decision 0009](/.agents/decisions/0009-research-hazard-dispositions.md).

For each implementer-facing hazard the document raised, give exactly one:

- **Promoted** — it became a binding requirement. Link the carrier: a spec
  hard-requirement, a decision record, a `components/` foot-gun, or a guard
  test / hook.
- **Deferred** — real, intentionally not handled now. Record the trigger that
  must reopen it; triggers are usually event-based ("before the first `/tmp`
  protocol schema change"), not date-based.
- **Out of scope** — judged not to apply. Record the reason.

One step is mandatory: **cross each hazard with claudemux's deployment model**
— one Claude Code session per teammate, the plugin loaded once per session. A
bare platform fact ("the platform behaves like X") becomes a claudemux hazard
only after that cross-product; skipping it is how a real hazard reads as
harmless background.

A doc that raised no implementer-facing hazard still carries the section,
stating so in one honest line. The section's job is to make the absence a
visible claim, not an untracked silence.

**When the section is written.** For a research doc written from now on, the
section is part of the snapshot — written before the doc is archived. For a
doc frozen before this discipline existed, the section is a dated, append-only
**appendix**; the snapshot body stays verbatim. `scripts/check.sh` fails a
research doc that has no `## Hazard dispositions` section, and CI runs it.

## Writing standard

- Write KB files in **English** (the repo convention for agent-facing docs).
- Prefer short bullets and tables over prose. State the rule and the reason;
  skip tutorials.
- Verify every path, function name, flag, and output string against the
  actual code before writing it. The KB must not drift from the executables.
- Link between KB docs, and to code, with **repo-root-absolute paths** — the
  link target begins with a slash. A link to this KB's `tm` component points
  at `/.agents/components/tm.md`; a link to the CLI itself points at
  `/plugins/claudemux/bin/tm`. `scripts/check.sh` validates every such link.
- Do not narrate rejected alternatives or repo history as warnings ("this
  used to be X"). State the rule that holds now. Decision records are the
  one place history belongs — and there it is framed as context, not as a
  prohibition.

## After editing the KB

Run the self-check from anywhere in the repo:

```bash
bash .agents/scripts/check.sh
```

It fails on a broken link and warns on an orphan document (a `.md` not
reachable by following links from `root.md`). Wire every new doc into the
navigation before you consider the change done.
