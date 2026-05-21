# 0007 — Teammates launch with the AskUserQuestion tool disabled

- **Status:** Accepted
- **Date:** 2026-05-21
- **Affects:** `tm` (`cmd_spawn`, `teammate_launch_flags`)

## Context

A teammate is a `claude` REPL running unattended in a `tmux` pane — no
human watches its terminal. The dispatcher drives it with the atomic
verbs (`tm send`, `tm spawn --prompt`, `tm resume --prompt`), each of
which blocks on the Stop hook's idle signal and prints the teammate's
reply.

The `AskUserQuestion` tool opens an interactive multiple-choice modal.
A turn that opens a modal does not end — the Stop hook never fires
while the modal is up. So when a teammate calls `AskUserQuestion`, the
dispatcher's sync verb blocks until its `--timeout` (default 1800s)
elapses, and the only way to unstick it is a manual `tmux send-keys`
into the pane. This was observed in practice: a `claude-plugin-feishu`
teammate froze exactly this way.

A teammate already has a working channel for raising questions: ending
its turn with plain text. That text is what `tm send` relays back to
the dispatcher on stdout — the dispatcher sees it and can answer. The
modal is not just unhelpful for a teammate; it is strictly worse than
the path that already works.

## Decision

Every teammate `tm` launches — fresh `tm spawn` and `tm resume` alike —
passes `--disallowedTools AskUserQuestion` to `claude`.

A bare tool name in `--disallowedTools` removes the tool from the
model's context entirely (it is not a denied-on-call rule). The
teammate never sees the tool, so it never calls it; it raises
questions by ending its turn with text, which is the path the
dispatcher can observe and answer.

The flag is built once in `teammate_launch_flags`, the single builder
for the `claude` flags shared by both launch paths. `tm resume`
reaches the REPL through `cmd_spawn`'s send-keys lines, so it inherits
the flag with no separate code path.

## Consequences

- A teammate cannot pop an `AskUserQuestion` modal; the freeze class
  above is gone.
- Teammates lose interactive multiple-choice prompting. This is
  intended: there is no human at the teammate terminal to answer one,
  and turn-ending text reaches the dispatcher instead.
- `ExitPlanMode` is the other built-in tool that blocks a turn on a
  human-input modal. It was left in scope deliberately — this change
  disables only the tool named in the originating task. A future task
  may extend `teammate_launch_flags` to deny it the same way; the
  builder is the one place to do so.
- `tm help spawn` documents the disabled tool, so the shipped help
  stays the source of truth for teammate launch behavior.

## References

- `plugins/claudemux/bin/tm` — `teammate_launch_flags`, `cmd_spawn`.
- [components/tm.md](/.agents/components/tm.md),
  [decisions/0002-atomic-tm-verbs.md](/.agents/decisions/0002-atomic-tm-verbs.md).
