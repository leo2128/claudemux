# Heterogeneous design-direction negotiation (scenario reference)

Read this when the dispatcher faces an upstream design choice — an interface, an abstraction, a directory layout, a routing scheme — and wants a second independent opinion from a different engine family before anchoring on a direction. Skip this reference when the choice is an implementation detail an author teammate can pick on its own (`dispatch-task.md`), or when the question is a factual one solvable by a single `grep`.

This workflow is the upstream sibling of `heterogeneous-review.md`. Where heterogeneous review vets a finished pull request, heterogeneous negotiation surfaces an independent direction *before* one is chosen.

## When to run

Open the workflow when any of these holds:

| Signal | Example |
|---|---|
| Multiple plausible directions exist; the dispatcher leans toward one but the evidence is weak | A routing decision with two candidates the dispatcher cannot tell apart from a single read |
| The decision is about an abstraction, interface, or directory layout — "once cast, hard to walk back" | Engine-interface shape, verb-layer-as-abstraction vs lower-level RPC |
| The user explicitly says "heterogeneous proposal" / "heterogeneous design negotiation" / "run a heterogeneous round" / "have two models evaluate this" / "get a second model's opinion" / "different models' opinions" | These are the named triggers |
| The blast radius is large and the evidence is single-threaded (one read of source, one observation) | An interface change that propagates through many call sites |

Do **not** open it for:

- Implementation detail an author teammate can pick on its own ("name this function X", "helper or inline").
- Small decisions inside an already-locked direction — `advisor` is enough.
- A factual question solvable by one `grep`.

## Roles — who produces what

| Role | Who | Hard constraint |
|---|---|---|
| Codex-side proposer | A fresh `tm spawn <name> --engine codex` teammate in a clean worktree | The prompt must not name any candidate the dispatcher has been considering, and the first line must say "do not anchor on any prior direction" |
| Claude-side proposer | A fresh `tm spawn <name> --engine claude` teammate in a clean worktree (mirror of the codex side) | The dispatcher itself is not one of the two legs |
| Synthesizer | The dispatcher | Receives both independent proposals; aligns them onto common axes; presents the differences to the user; does not pre-pick |

The dispatcher does not produce its own candidate proposal in the main context. The dispatcher's main context is shared with every other user task; spending it on candidate generation makes the dispatcher unavailable for other routing, and the "private" candidate then leaks into the synthesis as a third column, which defeats the heterogeneous-anchoring property the workflow exists for. Both legs run in fresh teammates; the dispatcher synthesizes.

`advisor` is same-family with the dispatcher and is never one of the two legs. It is allowed at synthesis time as a third-party sanity check on the two teammate outputs, but never used to generate a proposal that competes with them.

## Six-step workflow

**Step 1 — set up two clean worktrees.** One worktree for the Claude-side teammate, one for the Codex-side teammate. A small fixed pool of research worktrees (for example `<repo>-research` for Claude and `codex/<repo>-research` for Codex) keeps the auto-memory pool stable across HSN runs.

**Step 2 — spawn both teammates in parallel with the same prompt skeleton.** Identical prompts to both sides; the only difference is the engine label. Three sections in the prompt:

- **Problem statement** — facts only, no direction hint, no candidate names that the dispatcher has been considering. Name leakage anchors the teammate; if the dispatcher has been weighing "option Helper-Cache vs option Resident-Map", the prompt names neither.
- **Your task** — "independently propose; do not invoke any cross-review skill; do not spawn a sub-teammate."
- **Constraints** — "do not write code; do not read prior discussion; do not look up the dispatcher's preferences; output schema is locked; do not anchor on any prior direction (the dispatcher is intentionally withholding its candidates so you can think independently)."

Run both spawn calls with `run_in_background: true`. Wait for both task-completion notifications; do not poll the output files.

**Step 3 — wait silently.** The dispatcher does no work on this problem between the spawn and the two notifications. The main context stays free to route unrelated user requests. The synthesis must come from the two teammate outputs alone, not from a parallel thought line the dispatcher ran in the meantime.

**Step 4 — optional advisor sanity.** Once both proposals are in, the dispatcher may call `advisor` for a third-party sanity check on the two outputs together — not to generate a third proposal.

**Step 5 — synthesize on shared axes.** Pull both proposals onto the same evaluation axes — UX, implementation complexity, false-positive risk, consistency with existing patterns, extensibility. List the differences instead of smoothing them out. When the two disagree, the synthesis must show both intact; the dispatcher does not pre-pick.

**Step 6 — reply to the user with letter options.** Present an axis-aligned comparison of the two proposals, then list convergence points, divergence points, and the dispatcher's judgment with reason and risk. End with single-letter options (A / B / C / D) the user can pick by typing one character — that is faster and more reliable than expecting the user to author a long-form reply, especially on chat channels that cannot render structured-question modals.

## Locked output schema for the teammate proposals

The teammate spawn prompt must enforce this exact output structure so synthesis can align both proposals on the same shape. Without a locked schema, teammates tend to "restate the problem, argue background, then propose", and the synthesis step has to do shape-normalization first.

```
## My proposal
<one-line headline; 1–3 lines of explanation>

## Alternative
<one or two other workable directions; one line each plus trade-off>

## Recommendation and one-line reason
<which one you pick + why>
```

## Spawn-prompt scaffold (step 2)

```
# Your task
You are a {{Claude|Codex}}-engine independent design teammate. The dispatcher faces
a design choice (problem statement below). Produce an independent proposal — do
not read any prior discussion, and do not try to guess my preferred direction.

# Problem statement (facts only; no direction hint; no candidate names)
<3–10 lines>

# Output schema (hard locked)
## My proposal
  (one-line headline + 1–3 lines)
## Alternative
  (1–2 other workable directions, one line + trade-off each)
## Recommendation and one-line reason
  (which one + why)

# Red lines
- Do not write code.
- Do not invoke any cross-review skill, do not spawn a sub-teammate.
- Do not anchor on any prior direction — I am intentionally withholding my
  candidates so you can think independently.
- Do not use `--no-verify`; do not add a Claude `Co-Authored-By` trailer.
```

## User-reply scaffold (step 6)

```
Heterogeneous negotiation done. Two independent proposals:

# Claude side (fresh teammate)
<1–3 lines>

# Codex side (fresh teammate)
<1–3 lines>

# Axis-aligned comparison
| Axis | Claude proposal | Codex proposal |
| ---- | --------------- | -------------- |
<5–7 rows>

# Dispatcher synthesis
<recommendation + why + risks>

# Your call
a. <option A>
b. <option B>
c. <option C>
Reply a / b / c.
```

## Exception handling

| Situation | Action |
|---|---|
| Codex proposal happens to match Claude proposal | Treat the consensus as evidence, not a wasted run. Audit the problem statement before the next HSN — a converged answer often indicates the prompt leaked a direction hint. |
| Codex recommended a direction the dispatcher disagrees with | Copy Codex's reasoning into the user reply **verbatim**; do not soften, do not "translate". The user picks. |
| Codex sync wait reports `124` or `failed` after a long wait | Use `tm wait <codex-teammate>` to continue, not respawn — the thread is still alive on the daemon side |
| Both proposals are still unresolvable in front of the user | For small follow-up scope, let the two teammates negotiate directly (see `heterogeneous-review.md` for the small-PR pattern). For large architectural calls, escalate to user pin-down without further negotiation. |
| Codex anchors on an "innocent" name the problem statement leaked (helper name, library name) | Rewrite the prompt with the name abstracted ("an interface X"), respawn the Codex teammate. The leaked name is anchoring poison. |
| One teammate finishes minutes before the other | Wait for both. Do not let the early proposal start the synthesis — the synthesis must compare two complete proposals, not one proposal plus a wait. |
