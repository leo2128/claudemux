# 0002 — Atomic `tm` verbs with a stdout/stderr split

- **Status:** Accepted
- **Date:** 2026-05-16 – 2026-05-19
- **Affects:** `tm`, the dispatcher skill

## Context

The dispatcher's most common action is "send a prompt to a teammate and get
its reply back". An early `tm` exposed this as three separate verbs the
dispatcher had to chain every single time: send the prompt, then `wait` for
the turn to end, then `last` to read the reply. Three Bash tool calls, three
chances to forget a step, and a long blocking `wait` in the middle.

The dispatcher also drives spawn and resume with an initial prompt — and
those had a *different* calling convention from `send`, so the skill had to
remember which verb took a prompt how.

## Decision

Collapse the high-frequency path into **atomic round-trip verbs**, and give
them one calling form.

- `tm send <repo> --prompt "…"` is sync by default: it sends the prompt,
  blocks on the Stop-hook idle signal, and prints the reply itself. The
  3-step send/wait/last chain becomes one call.
- `tm spawn --prompt`, `tm send --prompt`, and `tm resume --prompt` all take
  the prompt the same way — one `--prompt` flag, free flag order, across all
  three verbs.
- The atomic verbs split their output by stream: the teammate's **reply
  goes to stdout**; status lines and the post-turn ctx echo go to
  **stderr**. This makes the reply cleanly pipeable and lets the verb hand
  back useful side-channel information (`ctx: N tokens · …`) without
  polluting the captured reply.
- `--no-wait` is retained for deliberate fire-and-forget; `--pane-quiet` is
  the fallback for TUI-only commands that fire no hook.

Both the command-set merge and the later `--prompt` unification were
**breaking changes**, shipped as deliberate major-intent bumps.

## Consequences

- The dispatcher skill is simpler: one verb, one form. Fewer steps to get
  wrong.
- Atomic verbs block for the length of a teammate turn. The dispatcher
  skill therefore mandates running every potentially-blocking `tm` call
  with `run_in_background: true`, so a wait never freezes the dispatcher.
- Anything that captures a `tm send` reply must read **stdout** only; a
  consumer that merges stderr will pick up status noise.
- The unification removed the old per-verb calling conventions — the
  shipped `tm <verb> --help` is the only contract a future agent should
  rely on.

## References

- Commits `864d289` (0.3.0 — merge send+wait+last, BREAKING), `d189baf`
  (0.3.1 — ctx echo to stderr), `70a8ac1` (0.5.0 — `cmd_send` to `--prompt`
  flag, BREAKING), `4546741` (0.5.1 — fix an empty-array splat crash under
  macOS bash 3.2 + `set -u`).
- [components/tm.md](/.agents/components/tm.md).
