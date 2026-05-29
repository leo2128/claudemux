# The dispatcher + per-repo `tmux` teammate model

- **Status:** Accepted
- **Date:** 2026-05-29 (recorded retroactively — the model was not designed up front; it grew, see Context)
- **Affects:** the foundational architecture — the dispatcher session, per-repo teammates, [`bin/tm`](/plugins/claudemux/bin/tm), the hooks, and the cross-process protocol. This record supplies the *why* that [root.md](/.agents/root.md) and [components/tm.md](/.agents/components/tm.md) describe only as *what*.

## Context

claudemux's user works across several sibling git repos under one parent directory and wants Claude help inside each. The shape that exists today was **not designed top-down**; it grew from a much smaller seed, and recording it honestly means recording that growth.

**The seed.** The first need was narrow: stand up one Claude conversation per sub-repo so the user could talk to each repo's Claude separately — originally from Remote Control. At that stage the **dispatcher did one thing: launch those per-repo conversations.** It was a launcher, not a coordinator. The experience target was "it feels like I opened a conversation directly inside that repo."

**Why a real `claude` REPL per repo, not Agent Teams / subagents.** Claude Code's built-in Agent Teams was investigated before `tm` was built. The decisive blocker was simple: **Agent Teams does not let you pin a teammate's working directory.** A per-repo worker *is* its cwd — the repo it operates in. A second limitation reinforced the choice and still holds: an Agent Teams teammate cannot load a repo's own memory files, whereas a real `claude` REPL launched with cwd set to the repo loads that repo's `CLAUDE.md` and AutoMemory natively. So each repo gets a real `claude` session in its own `tmux` session, cwd set to that repo.

**Why the teammate is isolated from the dispatcher.** To preserve the "talking directly to the repo" experience, a teammate is deliberately kept unaware that a dispatcher exists. This is not a git-root side effect — it is explicit: `tm spawn` launches `claude` with a `--settings` block whose `claudeMdExcludes` lists `<dispatcherDir>/CLAUDE.md` and `<dispatcherDir>/CLAUDE.local.md`, dropping them from the teammate's auto-loaded context. The teammate still loads its *own* repo's `CLAUDE.md` and AutoMemory natively, because its cwd is that repo. So a teammate behaves as a standalone conversation in its repo: its repo's context, and nothing from the dispatcher. This isolation is still endorsed — repo-scoped context plus per-repo memory is exactly what makes a teammate carry its repo's context and nothing else.

**How the dispatcher grew.** In use, it became clear the dispatcher could do more than launch — it could *coordinate* across several teammates and drive a task end-to-end across repos. To let it close that loop — manage and schedule every teammate, not just start them — the `tm` verb set grew (`states`, `history`, and the rest). The dispatcher's role accreted from launcher to full-flow coordinator. This was emergent, discovered through use, not planned at the start.

## Decision

claudemux is a **dispatcher session orchestrating per-repo teammates**, not a single session that works across all repos itself.

- **Dispatcher** — one Claude session in the parent workspace. It talks to the user and routes work. It began as a launcher and became the coordinator that schedules and inspects every teammate.
- **Teammate** — one real `claude` REPL per repo, each in its own `tmux` session with cwd set to that repo. Chosen over Agent Teams because Agent Teams cannot pin a cwd and cannot load the repo's own memory.
- **`tm` CLI** — the dispatcher's interface to spawn / message / wait on / inspect / kill teammates. Its verb set is the accreted surface that turned the dispatcher from launcher into coordinator.
- **File protocol** — `tm` and the per-session hooks never call each other; they coordinate through files under `/tmp` (the turn signal and the sid bridge). See [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md).
- **Teammate isolation is intentional and explicit** — a teammate need not know the dispatcher exists. `tm spawn` passes `claude` a `--settings` block whose `claudeMdExcludes` drops the dispatcher's `CLAUDE.md` / `CLAUDE.local.md` from the teammate's context; the teammate still loads its own repo's `CLAUDE.md` via its cwd. The shield is a deliberate setting, not a directory-layout accident.

## Consequences

- **The cwd requirement is load-bearing.** It is why teammates are `tmux` `claude` REPLs rather than Agent Teams, and why the project-dir encoding and the cwd identity gates exist at all ([cross-process-protocol](/.agents/domains/cross-process-protocol.md)).
- **Per-repo memory is a capability the built-in alternative could not give**, and remains a standing reason the model holds rather than migrating to Agent Teams.
- **Coordination state lives outside any shared session.** Because the dispatcher and teammates are isolated, the task ledger, identity records, and scheduling live in the dispatcher plus the `tm` verbs and the file protocol — not in a context the two share.
- **The verb surface is younger than the launch core.** `states` / `history` / full scheduling were added when coordination needs surfaced; a reader should not assume the whole model — or the whole verb set — existed from the start.
- **The isolation has a cost.** A teammate cannot see dispatcher-level intent unless the dispatcher passes it in the prompt — which is why the dispatcher skill insists on briefing teammates with intent rather than assuming shared context.
- **The shield is observable, not assumed.** A teammate session's startup context carries its own repo's `CLAUDE.md` but not `<dispatcherDir>/CLAUDE.md` — the direct, checkable confirmation that `claudeMdExcludes` is in force. The dispatcher file stays reachable on disk; it is simply not auto-loaded into the teammate's context.

## References

- [root.md](/.agents/root.md), [components/tm.md](/.agents/components/tm.md), [components/dispatcher-skill.md](/.agents/components/dispatcher-skill.md) — the *what* this record supplies the *why* for. `dispatcher-skill.md`'s "Delegation invariant" carries the related "route every teammate through `tm` rather than Agent Teams" rule.
- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md), [components/hooks.md](/.agents/components/hooks.md) — the file protocol the dispatcher/teammate split relies on.
- [decision hook-driven-busy-idle-signal](/.agents/decisions/hook-driven-busy-idle-signal.md), [decision atomic-tm-verbs](/.agents/decisions/atomic-tm-verbs.md), [decision teammates-launch-without-askuserquestion](/.agents/decisions/teammates-launch-without-askuserquestion.md) — sub-decisions made *within* this model.
- [decision node-cli-orchestrator](/.agents/decisions/node-cli-orchestrator.md) — why `tm` is a per-invocation CLI, not a resident process.
- `plugins/claudemux/src/engines/claude/spawn.ts` — `teammateSettingsJson` builds the `--settings` JSON (`claudeMdExcludes` shields the dispatcher's `CLAUDE.md` / `CLAUDE.local.md`; `worktree.baseRef`), and `teammateLaunchFlags` wraps it as `claude --settings '<json>' --disallowedTools AskUserQuestion`.
