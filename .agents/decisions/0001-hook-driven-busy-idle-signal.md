# 0001 — Hook-driven BUSY/idle signal

- **Status:** Accepted
- **Date:** Foundational; the settle predicate and timing were refined through 2026-05-20
- **Affects:** the hook bundle, `tm`, the cross-process protocol

## Context

`tm` must know when a teammate has finished a turn — `tm send` cannot print
a reply until the turn settles, and `tm wait` exists only to block on that
event. The teammate is a `claude` REPL in a separate `tmux` session; `tm`
has no in-process handle to it.

The obvious approach is to scrape the `tmux` pane: `capture-pane`, then
pattern-match Claude Code's UI for an idle prompt. That is fragile — pane
scrollback truncates, the TUI layout changes between Claude Code versions,
and "is the prompt idle" is a guess, not a fact.

Claude Code exposes lifecycle **hooks**. A hook fires on a real event with
structured JSON on stdin. That is a ground-truth signal, not a guess.

## Decision

Detect BUSY/idle purely through hooks writing marker files.

- `on-busy.sh` is bound to all four idle→working events
  (`UserPromptSubmit`, `UserPromptExpansion`, `PreToolUse`, `PreCompact`)
  and touches `/tmp/claude-idle/<sid>.busy`.
- `on-stop.sh` is bound to all four working→idle events (`Stop`,
  `StopFailure`, `PostCompact`, `SessionEnd`); it clears `.busy`, writes
  `<sid>.last` on `Stop`, and touches the `<sid>` idle marker.
- `tm`'s waiting verbs block on the idle marker file — no pane scraping.

The event sets are exhaustive in each direction so the signal is never
missed: a wait that only woke on `Stop` would hang forever on a `/compact`
turn (`PostCompact`) or an API-error turn (`StopFailure`).

A later refinement hardened `.last` extraction. The `Stop` hook can fire
before the final assistant API response is flushed to the transcript
jsonl, and a turn can split into a thinking-only response followed by a
text response. `on-stop.sh` now polls the jsonl (budget 15 s) for a
*settled* assistant entry — a terminal `stop_reason` **and** a `text` or
`tool_use` content block — before extracting, and leaves `.last` untouched
on timeout.

## Consequences

- The signal is reliable and version-independent — it does not depend on
  the TUI's appearance.
- The hooks fire for **every** Claude Code session on the machine,
  including the dispatcher. Markers are keyed by `session_id`, so there is
  no collision, but hooks must be cheap (`on-busy.sh` uses `sed`, not `jq`).
- A teammate not launched by `tm spawn` (no `CLAUDEMUX_TEAMMATE_REPO` env)
  still produces idle/busy markers but gets no sid-rotation bookkeeping.
- `tm` and the hooks now share an on-disk protocol that must evolve in
  lockstep — this is what motivates [decision 0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md).

## References

- Commits `dff9a9f` (switch to pure hook signaling), `82176b1` (settle
  predicate requires text/tool_use), `61179cd` (hook diagnostics),
  `be884f0` (0.5.7 — `on-stop.sh` rewrite), `eabedb1` (0.6.1 — extend the
  jsonl-settle poll cap 3 s → 15 s).
- [components/hooks.md](/.agents/components/hooks.md),
  [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md).
