# Compact a Claude teammate (scenario reference)

Read this when a Claude tmux teammate's context window is filling up and you want to compact its transcript before the next turn. Skip when you are sending fresh work or waiting on a turn; those use `tm send` / `tm wait`.

## Check fill: `tm ctx`

`tm ctx <repo>` (or `tm ctx --all`) reads the jsonl usage block for accurate prompt size. Do not rely on the TUI status-bar percentage. Run `tm ctx --help` for the window heuristic and `--window 200k|1m` override.

## When to compact between phases

A phase boundary is a natural compaction point. When a teammate reports phase N done and phase N+1 is still to come, run `tm compact <repo>` before sending the next phase — then `tm send` the next prompt into the freshly compacted context. The previous phase's exploration, tool output, and dead-end reasoning are mostly noise for the next phase, and compacting at the boundary keeps a mid-task auto-compact from interrupting the teammate's working state later.

Checking `tm ctx` first is optional here — a finished phase is reason enough on its own to compact. The teammate is already idle at the boundary, so the compact is safe; just do not overlap it with any other input to the same teammate (see `wait-and-readback.md` §"Don't send extra input during a sync wait").

## Compact

```bash
tm compact <repo> [timeout=1800] [--timeout N]
```

Sends `/compact` to the teammate, waits for the **PostCompact** hook to fire, and prints `compacted` on stdout when the idle marker arrives. Default timeout is 1800 s.

Run every `tm compact` with `run_in_background: true` on the Bash tool. Compaction can take minutes; the harness fires a task notification when the verb returns.

Run `tm compact --help` for the full flag/output contract.

## Non-success modes

| Mode | Exit | What to do |
|---|---|---|
| `"Not enough messages to compact"` | `1` | The transcript is too short. Treat this as a true refusal; continue without compacting. |
| PostCompact never fires within `--timeout` | `124` | The teammate may still be compacting. Do not respawn or kill on this code; use `tm status <repo>` to inspect the pane, or keep watching with `tm wait <repo>`. |

## Verifying compact success

Read the verb's own stdout: the literal string `compacted` means the compact succeeded — move on to the next `tm send`. An error string or a hang is the failure signal.

Do not chase a follow-up `tm ctx <repo>` to "double-check" the new size. `tm ctx` estimates the context window from the jsonl file's size, but the transcript is append-only — a `/compact` writes a PreCompact marker and a new system message into the same jsonl rather than truncating it, so the file never shrinks across a successful compact. The post-compact `tm ctx` number is therefore stale by design, not by bug. If you surface a "ctx is now N tokens" data point to the user after a compact, that number is wrong; drop it.

## Codex teammates auto-compact

`tm compact <codex-target>` is a no-op for Codex teammates. The verb writes an empty stdout and the line

```
  not supported: codex compacts its own context automatically when the 252k window fills
```

to stderr, with exit code 0. Calling it defensively is safe, but skip it as a deliberate between-phase ritual. The Codex daemon watches its own thread token count and runs compaction internally when the 252k window fills; there is no Claude-style external `/compact` hook to drive. Between phases on a Codex teammate, just `tm send` the next prompt — the "compact between phases" rule above applies to Claude teammates only.

Where to look for the success signal depends on the engine: Claude writes `compacted` to **stdout** on success, while Codex writes the `not supported: ...` line to **stderr** with empty stdout. Both paths exit 0. The skill-wide rule — trust the verb's own success signal, do not chase a follow-up `tm ctx` — still holds across engines; just read the right stream for the engine you are calling.
