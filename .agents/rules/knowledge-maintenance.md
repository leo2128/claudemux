# Rule: knowledge maintenance

This rule governs how a future agent keeps the `.agents/` KB accurate. It is
the short, durable form; the full rationale and layout are in
[CONTRIBUTING.md](/.agents/CONTRIBUTING.md).

## The rule

Before finishing any non-trivial task, run a knowledge-delta review:

1. Did this task change a future agent's **starting point, routing,
   component boundary, cross-process contract, or a known foot-gun**?
2. If **yes** — update the matching KB document in the same change. Treat a
   change that outdates the KB as unfinished.
3. If **no** — add nothing. The KB earns its value by being short and
   trustworthy; padding it for completeness erodes both.

## Where each kind of knowledge lands

| The change is about… | Update… |
|---|---|
| What claudemux is, repo layout, navigation | [root.md](/.agents/root.md) |
| One component's entry points or foot-guns | the matching `components/*.md` |
| A contract spanning components (the `/tmp` protocol, a `tm`↔hook seam) | the matching `domains/*.md` |
| A design choice worth preserving the reasoning for | a new record under `decisions/` |
| A binding repo rule (invariants, versioning, commit author, audience boundaries) | the repo-root `CLAUDE.md` — *not* the KB |

The last row matters: the KB is the *narrative* layer. Binding rules belong
in `CLAUDE.md` (always loaded) or, where the rule can be mechanically
enforced, in an executable contract (a hook, `bin/check-author`,
`bin/bump-version`). The KB explains and routes; it does not legislate.

## Decision records

When a task settles a design question — a trade-off, a reversal, a contract
that the next agent would otherwise re-debate — add a numbered record under
`decisions/`. Follow the format in
[decisions/README.md](/.agents/decisions/README.md). A decision record is
append-only history: do not delete an old record when the decision is later
superseded; add a new record and mark the old one `Superseded by …`.

## Verification

After any KB edit, run `bash .agents/scripts/check.sh`. It must report no
broken links. Resolve any orphan-document warning by linking the new doc
into the navigation, or by deleting the doc if it is no longer needed.
