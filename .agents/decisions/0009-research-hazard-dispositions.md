# 0009 — Every research hazard reaches a recorded disposition

- **Status:** Accepted
- **Date:** 2026-05-21
- **Affects:** the `.agents/` knowledge-flow process — `research/`,
  `decisions/`, `CONTRIBUTING.md`, `rules/knowledge-maintenance.md`,
  `scripts/check.sh`, and the CI workflow.

## Context

`research/feishu-channel-notes.md` recorded two platform hazards for the
Feishu channel. Their fates diverged completely:

- **Process leak.** A long-lived WebSocket plus an MCP stdio server leaks if
  shutdown is an afterthought. → spec hard-requirement #3 → decision 0006
  (`ShutdownCoordinator`) → `shutdown.test.ts`. The full pipeline.
- **Cluster delivery, not broadcast.** Feishu delivers each inbound event to
  exactly one of an app's connections — "do not assume fan-out" (§1.2, under a
  heading reading "实现时必须知道"). → recorded nowhere downstream. No spec
  requirement, no decision, no code, no test. It surfaced as a production bug,
  fixed in `626c6b3` on branch `fix/feishu-channel-single-instance`.

Both were flagged as things the implementer had to know. One travelled the
whole research → spec → decision → code → guard-test path; the other never
left the page it was written on.

The cause is not the KB structure — `research/`, `decisions/`, `components/`,
`domains/`, `rules/` are each well-scoped. It is that **every hand-off between
layers is a lossy filter biased toward imperatives.** The process-leak hazard
was written as an imperative aimed at the implementer ("we must handle
graceful shutdown from day one" plus a concrete prescription) — already in the
shape of a requirement. The fan-out hazard was written as a platform fact plus
a caution; it became a claudemux hazard only when crossed with a second fact
the research never crossed it with — that the channel plugin loads into every
Claude Code session, so a fleet of teammates is a fleet of MCP servers sharing
one Feishu app. A hand-off that lifts ready-made requirements passes the first
and silently drops the second, and nothing records that a drop happened.

A back-test confirmed the mechanism is general, not a one-off.
`research/architecture-review.md` raised four hazards in one document: a
project-dir encoding bug, BSD-only `stat -f`, scattered path-builder literals,
and the absence of a `/tmp` protocol version field. The first three — each a
present, active defect — travelled into decisions 0003 / 0004 and the repo
`CLAUDE.md`. The fourth, written as "acceptable today; locks in friction for
the first schema change", did not: `bin/tm` and the hooks still carry no
version field. The `parse_hook_payload` hazard from the same audit's §4 — a
Claude Code hook-payload field rename would break three hook scripts in
parallel — is likewise unaddressed; the three hooks still extract `session_id`
by three different inline methods. Both stalled hazards share the fan-out
hazard's shape: a conditional future risk that bites at a trigger event, not a
defect that is broken now.

Even adversarial review did not catch the gap. `research/feishu-crossreview.md`
was an independent cross-review that found six must-fix defects — and missed
fan-out, because it reviewed against the spec, and the spec's blind spot
propagated straight into the review. More review is not the fix; the fix has
to sit on the research → spec boundary itself.

One tension had to be resolved before the fix could land. The research
archive's rule is that a snapshot is frozen — "do not edit them to fix drift"
(`research/index.md`). A disposition section written into a *new* research doc
before it is archived is part of the snapshot from birth and raises no
conflict. But the nine research docs already frozen predate this discipline,
and the very hazards it exists to catch (fan-out, the protocol version field)
live in them. Leaving them untouched would mean the rule born from the fan-out
miss could not record the fan-out miss.

## Decision

Every research document reconciles the hazards it raised to an explicit,
recorded disposition. No implementer-facing hazard may leave a research doc
without one.

### The hazard-disposition section

A research document carries a closing `## Hazard dispositions` section. It
lists every implementer-facing hazard the document raised — a constraint,
trap, or platform fact that, if mishandled, breaks the product — and gives
each one exactly one disposition:

- **Promoted** — the hazard became a binding requirement. Records a link to
  its carrier: a spec hard-requirement, a decision record, a `component`
  foot-gun, or a guard test / hook.
- **Deferred** — real, but intentionally not handled now. Records the trigger
  that must reopen it. Triggers are usually event-based ("before the first
  `/tmp` protocol schema change"), not date-based.
- **Out of scope** — judged not to apply. Records the reason.

The exercise includes one mandatory step: **cross each hazard with claudemux's
deployment model** — one Claude Code session per teammate, the plugin loaded
once per session. That cross-product is what converts a bare platform fact
into a claudemux hazard, and it is the step the fan-out miss skipped.

A disposition kills only the *silent* drop. A hazard may still be deferred or
ruled out of scope — but on the record, with a reason a reviewer can read and
challenge.

### New docs versus the already-frozen ones

For a research doc written from now on, the section is written before the doc
is archived — part of the snapshot from birth, like the date in its header.

For the nine docs already frozen, a `## Hazard dispositions` **appendix** is
appended, clearly dated and marked as added after the freeze. This does not
violate the frozen-snapshot rule: that rule protects the snapshot *body* from
being rewritten to look current, and the appendix rewrites nothing in the body.
The appendix is itself append-only — the same model the decision records
already follow. All nine are backfilled in the change that introduces this
decision.

### A promoted hazard names its enforcement

When a decision record promotes a hazard into a binding constraint, its
Consequences names the enforcement that prevents silent regression — a guard
test, a hook, or a `check.sh` rule — or states why none is mechanically
possible. This is the practice decision 0008 already followed voluntarily for
`test/mcp-config.test.ts`; it is now the expectation. Recorded in
`decisions/README.md`.

### The gate

`scripts/check.sh` gains a third check: every file under `.agents/research/`
except `index.md` must contain a `## Hazard dispositions` section. `check.sh`
is wired into CI so the gate runs on every push and pull request.

The gate is mechanical because the prior discipline was not. The knowledge-delta
protocol in `CONTRIBUTING.md` already asked agents to keep the pipeline moving,
and the fan-out hazard slipped past it anyway — an advisory rule that is not
recalled is indistinguishable from one that does not exist. Adding another
advisory rule would repeat the failure; the discipline needs a check a build
fails on.

## Consequences

- A hazard flagged in research can no longer vanish without a trace. Its
  outcome is a written disposition a reviewer can challenge — the difference
  between fan-out's fate and the process leak's.
- The gate verifies the section is **present**, not that it is **complete or
  correct**. A doc can satisfy it with `## Hazard dispositions` followed by
  `None.` That is acceptable: `None.` is a visible, falsifiable claim, where
  the prior state offered a reviewer nothing to question. Completeness of the
  hazard list and honesty of each disposition remain a human-review
  responsibility; the gate only guarantees the prompt is always present.
- This decision satisfies its own rule. It promotes a hazard class — silently
  dropped research hazards — into a binding constraint, and its enforcement is
  named: the `check.sh` research-doc check, run in CI.
- The frozen-snapshot rule now distinguishes the snapshot body (frozen) from a
  dated, append-only reconciliation appendix (permitted). `research/index.md`
  records this carve-out and points here for the reason.
- The operational detail — when to write the section, the disposition
  vocabulary, the deployment-model cross step — lives in `CONTRIBUTING.md`;
  `rules/knowledge-maintenance.md` carries the short rule. A future agent
  finishing a research round reads those, not this record.

## References

- The motivating miss: `research/feishu-channel-notes.md` §1.2 (the fan-out
  hazard), fixed in `626c6b3` (branch `fix/feishu-channel-single-instance`).
- The back-test: `research/architecture-review.md` §2 / §4 / Top-3 #3,
  `research/research-report.md` steal #4.
- [CONTRIBUTING.md](/.agents/CONTRIBUTING.md) — the discipline's operational
  home.
- [rules/knowledge-maintenance.md](/.agents/rules/knowledge-maintenance.md),
  [research/index.md](/.agents/research/index.md),
  [scripts/check.sh](/.agents/scripts/check.sh).
- [decision 0006](/.agents/decisions/0006-feishu-channel-event-registry.md),
  [decision 0008](/.agents/decisions/0008-feishu-channel-launch-without-session-proxy.md)
  — the process-leak hazard's carrier and the enforcement-naming precedent.
