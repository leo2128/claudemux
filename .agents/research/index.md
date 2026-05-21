# Research archive

This directory archives the **research artifacts** produced while building the
`feishu-channel` plugin and while auditing claudemux's `tm` core. They are
kept here so the investigation behind a decision is recoverable — a decision
record states *what was chosen*; these documents are *the legwork that backed
the choice*.

## These are frozen snapshots — read them as history

Every file here is a **point-in-time snapshot**. It records what was known,
measured, or reviewed on its stated date and is **not maintained afterwards**.
This is the opposite of [decisions/](/.agents/decisions/README.md), which are
living records kept consistent with the code, and of `components/` /
`domains/`, which are updated whenever the thing they describe moves.

Practical consequences when you open one of these:

- **Do not treat a fact here as current.** A version number, a commit hash, a
  test count, an API field, a "not yet done" — all were true on the date in
  the header and may have moved since. Verify against the code before acting.
- **Do not edit them to "fix" drift.** Correcting a snapshot destroys the
  snapshot. If the world moved, the right home for the new truth is a
  `component`/`domain` doc or a new decision record — not an edit here.
- **The decision record is the authority.** Where a snapshot and a decision
  record disagree, the decision record (kept fresh) wins; the snapshot just
  shows the reasoning at the time.

Archived documents are kept **verbatim** in their original language (the
Feishu research was written in Chinese, the `tm` audits in English).

## Feishu channel research

Background for [0005 — Feishu channel plugin](/.agents/decisions/0005-feishu-channel-plugin.md)
and [0006 — Feishu channel event registry](/.agents/decisions/0006-feishu-channel-event-registry.md).

| Document | Snapshot of | Date | Feeds |
|---|---|---|---|
| [feishu-channel-spec.md](/.agents/research/feishu-channel-spec.md) | The requirements spec the plugin was built against — hard requirements, the per-round event scope, and the deliverables list. | 2026-05-21 | [0005](/.agents/decisions/0005-feishu-channel-plugin.md), [0006](/.agents/decisions/0006-feishu-channel-event-registry.md) |
| [feishu-channel-notes.md](/.agents/research/feishu-channel-notes.md) | From-scratch survey of the Feishu Open Platform APIs (tenant_access_token, the message API, the long-connection mode) and the Claude Code channel protocol. | 2026-05-21 | [0005](/.agents/decisions/0005-feishu-channel-plugin.md) |
| [channel-references.md](/.agents/research/channel-references.md) | Survey of existing Claude Code channel implementations (the four official channels carry no tests; one community Slack channel is the testing benchmark) and the test methodology drawn from them. | 2026-05-21 | [0005](/.agents/decisions/0005-feishu-channel-plugin.md) |
| [feishu-events-notes.md](/.agents/research/feishu-events-notes.md) | Full map of Feishu's event-subscription catalogue and a payload study of the document-comment event, each field tagged with how trustworthy its source is. | 2026-05-21 | [0006](/.agents/decisions/0006-feishu-channel-event-registry.md) |
| [multi-channel-notes.md](/.agents/research/multi-channel-notes.md) | Investigation of whether one Claude Code session can host several channels at once (yes — but events are serialized into one session queue). | 2026-05-21 | [0006](/.agents/decisions/0006-feishu-channel-event-registry.md) |
| [feishu-crossreview.md](/.agents/research/feishu-crossreview.md) | First-round independent cross-review of the plugin — five dimensions, a Top-6 must-fix list with two ❌-level findings. | 2026-05-21 | [0005](/.agents/decisions/0005-feishu-channel-plugin.md), [0006](/.agents/decisions/0006-feishu-channel-event-registry.md) |

> **On `feishu-crossreview.md`:** it captures the *first* review pass. All six
> findings were resolved in the plugin's round-3c work; the snapshot is kept
> as the record of what the review caught, not as an open defect list.

## claudemux quality & architecture research

Background for [0003 — `tm` quality hardening](/.agents/decisions/0003-tm-quality-hardening.md)
and [0004 — cross-process / cross-platform invariants](/.agents/decisions/0004-cross-process-cross-platform-invariants.md).

| Document | Snapshot of | Date | Feeds |
|---|---|---|---|
| [architecture-review.md](/.agents/research/architecture-review.md) | Seven-dimension read-only audit of `bin/tm` and its co-process partners — layering, protocol evolvability, cross-platform safety, and the idle-dir / jsonl path-builder gaps. | 2026-05-20 | [0003](/.agents/decisions/0003-tm-quality-hardening.md), [0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md) |
| [research-report.md](/.agents/research/research-report.md) | Desk research comparing claudemux against industry practice for plugin authoring, CI, and Bash CLI testing, with the gaps called out. | 2026-05-20 | [0003](/.agents/decisions/0003-tm-quality-hardening.md), [0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md) |
| [investigation-context-window.md](/.agents/research/investigation-context-window.md) | Probe of whether a teammate's real model and context-window size can be discovered without a model turn (conclusion: largely not — every layer checked lacks the signal). | 2026-05-20 | No decision record — a negative-result probe; explains why `tm`'s `ctx` line falls back to `assumed 200k`. |
