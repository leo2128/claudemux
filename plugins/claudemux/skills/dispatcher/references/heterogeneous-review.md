# Adversarial cross-engine PR review (scenario reference)

Read this when the dispatcher is driving a pull-request review whose reviewer should come from a **different** engine family than the author — Claude code reviewed by Codex, or Codex code reviewed by Claude. The reviewer's job is to find problems the author's engine family is statistically likely to have missed. Skip this reference when the user has already merged the PR by hand, or when there is no PR (use `dispatch-task.md` for plain spawning).

## When to run

Trigger this workflow on any of these signals:

| Signal | Action |
|---|---|
| User says "review this" / "send a reviewer" / "adversarial review" / "cross-engine review" / "merge this PR" / "heterogeneous review" | Open the workflow |
| Dispatcher itself has reached the point of deciding whether a PR is ready to merge | Open the workflow before merging |
| The change touches shared low-level surface (CLI verbs, plugin contracts, hooks, engine interfaces) | Open the workflow even when the author is confident |
| Author force-pushed a fix to an in-progress review | Recheck loop (Phase D), do not spawn a fresh reviewer |

Skip the workflow when the PR is pure documentation that does not touch routing or contract surface, when the author has already produced a documented review report of equivalent rigor, or when the user has already merged.

## Engine pairing — the one hard rule

The reviewer engine must differ from the author engine:

| Author engine | Reviewer engine | Why |
|---|---|---|
| Claude | Codex | Same-family reviewers share training-distribution blind spots |
| Codex | Claude | Same as above, inverted |
| advisor (either side) | Sanity check only, never one of the two legs | advisor and the dispatcher are same-family |

Pick the author engine by task fit (Bash / hook / CLI scaffolding work fits Claude; async-heavy or Codex-internal work fits Codex) — author is not forced to be heterogeneous, only the reviewer side is.

Identify the author engine before spawning the reviewer. `tm states` is not enough on its own — its `SID` column shows only the first 8 characters, and a Codex thread-id UUID truncated to 8 characters looks identical to a Claude session-id prefix. Use a source that actually carries the engine instead:

- the `engine` field on the teammate's identity record (the persisted base `TeammateRecord` JSON);
- the ledger entry for the active task, which records the engine alongside the teammate name;
- the user's local worktree-naming convention if one is in place (for example, Codex worktrees carrying a leading `codex/`); and the author worktree carries no `-review-` suffix regardless of engine.

When in doubt, ask the author teammate to print its own engine name in its next status reply rather than guessing from the fleet snapshot.

## Phase A — prepare

1. **Confirm the PR is ready to review.** If the author teammate has self-reported "PR pushed, CI green, mergeable", that is enough. If the author has gone idle (auto-compact, stuck mid-task), the dispatcher pulls the state itself with `gh pr view <NN> --json headRefOid,statusCheckRollup,mergeStateStatus`; a `CLEAN` `mergeStateStatus` is enough to launch the reviewer.

2. **Create the reviewer worktree from the feature branch.** Pick a worktree path under a small fixed pool that you reuse across reviews — for example `<repo>-author` / `<repo>-reviewer` / `codex/<repo>-author` / `codex/<repo>-reviewer` — instead of opening a new worktree per PR. Each fresh worktree resets that teammate's auto-memory (the project-dir hash changes), so a stable pool keeps memory continuity.

   ```bash
   git -C <main-repo> worktree add <reviewer-worktree-path> -b review/pr-<NN> <feature-branch>
   ```

3. **Spawn the reviewer teammate with the opposite engine.** Write the prompt to a file first so the recheck loop can quote it verbatim later; then spawn with `run_in_background: true` and wait for the task-completion notification — do not poll the output file.

   ```bash
   PROMPT=$(cat /tmp/spawn-review-<NN>.md)
   tm spawn <reviewer-teammate-name> --engine <opposite-of-author> --prompt "$PROMPT"
   ```

   Do not include any step in the reviewer's prompt that asks it to invoke a `cross-review` skill. The pipeline already enforces cross-engine review at the teammate level — adding a second engine-pair inside the reviewer doubles the same blind spot when the author and that inner pair share an engine, and burns wall-clock time on a duplicate review.

## Phase B — the reviewer spawn prompt

The spawn prompt has six parts. Each part has a job; do not drop any of them.

```
# Who you are
You are the reviewer for PR <NN>, on the <reviewer-engine> engine. The author is on <author-engine>.
Adversarial cross-engine review is required — find problems, be unfriendly, do not soften.
This pairing exists to surface the blind spots a same-engine reviewer would miss; do not waste it.

# PR information
URL: <pr-url>
Source branch: <feature-branch>
Base: <base-branch>
Author's claim of what landed: <one-line summary>

# Audit scope (3–5 blocks along the main change line)
1. <area 1>
2. <area 2>
...

# Adversarial axes (actively look for these)
- Boundary cases (empty, very large, multiple-at-once, CJK byte-vs-char)
- Dead code, redundancy, misplaced responsibility, mapping drift
- Test coverage (mock vs real, boundary, negative assertion)
- Built-artifact diff (dist / generated code vs source)
- Changeset level (patch / minor / major — check for unflagged breaking changes)
- Dependency floor / runtime version compatibility
- Backwards compatibility (older client assumptions)

# Output
- Post findings via `gh pr comment <NN> -F <file>`
- Grade P0 / P1 / P2; every finding has file:line + problem + suggestion
- If you find no P0 / P1, post "LGTM, mergeable. Axes audited: ..." as a top-level comment
- End the turn after posting; do not "report back to dispatcher"

# Red lines
- Do not modify PR code, do not commit, do not push
- Do not run `gh pr review --approve` or `--request-changes` (the author and reviewer share the same git identity; GitHub will refuse)
- Do not use `--no-verify`, do not add a Claude `Co-Authored-By` trailer
- Do not invoke any `cross-review` skill — that skill is `disable-model-invocation: true` plugin-wide for this exact pipeline
```

The "Who you are" identity line and the "adversarial cross-engine review is required" framing raise the reviewer's adversarial posture in practice. Keep both intact; do not soften them when filling in the template.

End the prompt at "post the comment and stop" rather than "ping the dispatcher". The dispatcher receives the reviewer's stdout via the `run_in_background: true` task-completion notification — the report is already on its way.

## Phase C — verdict bucketing

When the reviewer's task-completion notification arrives, bucket the verdict:

- **Clean** (0 P0 / 0 P1, P2 acceptable) → go to Phase E and merge.
- **Has P0 or P1** → write `/tmp/send-<NN>-fix.md` for the author teammate. Quote each reviewer finding **verbatim** (do not paraphrase or soften — the verbatim quote is what anchors the author's response and the recheck reviewer's re-evaluation). For each finding, state the operation (file:line → what changes) and the completion condition (what proves the fix worked). Then `tm send <author-teammate> --prompt "$(cat /tmp/send-<NN>-fix.md)"`, with `run_in_background: true` (and wait for the task notification — do not poll). When the author force-pushes the fix branch, go to Phase D.
- **Has P2 only** → the dispatcher decides between merging now (logging the P2 as a follow-up task) and a one-shot fix.

For a series of small follow-up PRs (nit fixes, cleanup, minor features), prefer letting the author and reviewer hash out scope and approach directly — the dispatcher just verifies that the reviewer posted findings and the author addressed them. Escalate to the user only when the two teammates genuinely cannot reach a call and the disagreement is about a user-facing tradeoff, not implementation detail. Large architectural PRs are different: those still need user pin-down on the design call.

## Phase D — recheck

Send the recheck to the **same** reviewer teammate. Do not spawn a fresh reviewer, because a fresh reviewer would re-audit the whole PR from zero — re-introducing the noise the original reviewer already filtered out, and dropping the prior anchors.

```bash
PROMPT=$(cat /tmp/send-review-<NN>-recheck.md)
tm send <reviewer-teammate-name> --prompt "$PROMPT"   # run_in_background: true; wait for the notification
```

The recheck prompt must include:

- The previous review findings **verbatim** — anchors the reviewer to its own prior axes instead of re-auditing from scratch.
- The author's reported fix descriptions — so the reviewer can compare diff against claim.
- The new head SHA and CI status.
- Explicit reuse instructions: `git -C <reviewer-worktree> fetch origin && git -C <reviewer-worktree> reset --hard origin/<feature-branch>`.
- The same red-line block as the Phase B prompt.

The recheck can surface new P0 / P1 findings; if it does, loop back to Phase C. One to two recheck rounds is the empirical convergence point; three or more rounds is a signal to escalate to the user rather than keep looping.

If the author force-push erased the exact line a reviewer finding anchored on, the recheck prompt should quote the **problem description**, not the line number — let the reviewer re-locate the issue.

## Phase E — squash and three-piece cleanup

Run all four commands in the same turn as the merge — the cleanup steps are not "later":

```bash
gh -R <org>/<repo> pr merge <NN> --squash
tm kill <reviewer-teammate-name>
git -C <main-repo> worktree remove --force <reviewer-worktree-path>
git -C <main-repo> branch -D review/pr-<NN>
```

The three cleanup steps are independently idempotent: `tm kill` failing because the daemon or session is already gone is harmless; `worktree remove` needs `--force` because the worktree's HEAD is on the review branch, which Git treats as an active checkout; `branch -D` (uppercase D) is required because Git treats the review branch as unmerged even after a squash-merge (its commits landed on `<base>` via a new squash commit, not via fast-forward).

The author branch is usually auto-deleted by GitHub on squash; verify with `gh pr view <NN> --json state,mergedAt,mergeCommit` and clean up the author worktree and teammate the same way once the matching ledger task closes.

If you intend to keep the reviewer alive for a second pass on follow-up nits, mark the cleanup as a known deferred step in the ledger and run it the moment the second pass is done. Skipping cleanup quietly accumulates worktrees, tmux sessions, and `/tmp/teammate-*` files.

## Exception handling

| Situation | Action |
|---|---|
| `mergeStateStatus` is `DIRTY` because the base advanced | Send the author a rebase-only prompt (`git fetch + rebase + resolve + verify + force-push`); do not ask the reviewer to rebase the review branch |
| CI keeps failing for reasons unrelated to review (dist staleness, hook regression, infrastructure flake) | Pause the review, spawn a separate fix author for the CI issue, resume the review when CI is green |
| Reviewer and author persistently disagree on one finding | Escalate to the user with both positions side-by-side; do not pick a side from the dispatcher chair |
| Author force-push erased the line a finding anchored on | Recheck prompt quotes the problem description, not the line number; let the reviewer re-locate |
| Author auto-compacted and never reported readiness | Dispatcher reads `gh pr view <NN>` itself; if `mergeStateStatus` is `CLEAN`, spawn the reviewer anyway |
| `gh pr review --approve` or `--request-changes` is rejected because the author and reviewer share a git identity | Use `gh pr comment <NN> -F <file>` for the top-level comment instead; the same-identity gate does not apply to comments |
| Reviewer attempts to invoke a `cross-review` skill despite the global disable | `tm kill` that reviewer and respawn with explicit "do not invoke any cross-review skill" in the prompt |
