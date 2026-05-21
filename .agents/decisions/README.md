# Decision records

This directory holds claudemux's **decision records** — the *why* behind the
system's shape. Each record captures one design choice: the situation that
forced it, the choice made, and what the choice now costs or constrains. A
future agent reads these to avoid re-litigating a settled question.

## Index

| # | Decision | Status |
|---|---|---|
| [0001](/.agents/decisions/0001-hook-driven-busy-idle-signal.md) | BUSY/idle detection is driven by Claude Code hooks, not pane scraping | Accepted |
| [0002](/.agents/decisions/0002-atomic-tm-verbs.md) | `tm`'s high-frequency verbs are atomic round-trips with a stdout/stderr split | Accepted |
| [0003](/.agents/decisions/0003-tm-quality-hardening.md) | `tm` was hardened with CI, bats tests, lint, and shared path/encoding helpers | Accepted |
| [0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md) | Three cross-process / cross-platform invariants were promoted into `CLAUDE.md` | Accepted |
| [0005](/.agents/decisions/0005-feishu-channel-plugin.md) | A Feishu channel ships as a separate TypeScript+Bun plugin from this repo | In progress |
| [0006](/.agents/decisions/0006-feishu-channel-event-registry.md) | The Feishu channel handles events through an extensible registry of per-event handlers | In progress |
| [0007](/.agents/decisions/0007-teammates-launch-without-askuserquestion.md) | Teammates launch with the `AskUserQuestion` tool disabled | Accepted |
| [0008](/.agents/decisions/0008-feishu-channel-launch-without-session-proxy.md) | The Feishu channel's MCP server is launched with the session HTTP proxy cleared | Accepted |
| [0009](/.agents/decisions/0009-research-hazard-dispositions.md) | Every research hazard reaches a recorded disposition before it leaves the research layer | Accepted |
| [0010](/.agents/decisions/0010-feishu-channel-group-pairing.md) | A Feishu group is authorized by pairing — an @-mention posts a code the operator approves | Accepted |
| [0011](/.agents/decisions/0011-feishu-doc-comment-enrichment.md) | The Feishu doc-comment handler decodes via the SDK and enriches the event with fetched text and title | Accepted |
| [0012](/.agents/decisions/0012-feishu-channel-group-policy-modes.md) | Feishu group access is a three-mode `groupPolicy` switch — block / allowlist (decision 0010) / follow-user | Accepted |
| [0013](/.agents/decisions/0013-feishu-channel-received-reaction-indicator.md) | The Feishu channel marks an inbound chat message with a reaction when it reaches the session, and clears it on reply | Accepted |
| [0014](/.agents/decisions/0014-changeset-release-versioning.md) | Versioning moves to changeset fragments consumed by a release step, so parallel PRs never collide on the version line | Accepted |

## When to add a record

Add a numbered record when a task settles a design question that the next
agent could otherwise re-debate: a trade-off, a reversal, a contract choice,
or a "we tried X and chose Y" outcome. A routine bug fix does not warrant a
record. See [rules/knowledge-maintenance.md](/.agents/rules/knowledge-maintenance.md).

## Format

Name files `NNNN-kebab-slug.md` with the next free number. Use this
skeleton:

```
# NNNN — Short title

- **Status:** Accepted | In progress | Superseded by NNNN
- **Date:** YYYY-MM-DD (or a range)
- **Affects:** the components this touches

## Context
The forces in play — what made a decision necessary.

## Decision
What was chosen, stated plainly.

## Consequences
What this now costs, constrains, or enables. Include the foot-guns.

## References
Commit hashes, files, related decision records.
```

When a record promotes a hazard into a binding constraint, its
**Consequences** names the enforcement that prevents silent regression — a
guard test, a hook, or a `scripts/check.sh` rule — or states why none is
mechanically possible. See [decision 0009](/.agents/decisions/0009-research-hazard-dispositions.md).

Records are **append-only history**. When a decision is later overturned,
do not edit or delete the old record — add a new one and set the old
record's status to `Superseded by NNNN`.
