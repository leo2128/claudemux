# Compact a teammate (scenario reference)

Read this when a teammate's context window is filling up and you want to compact its transcript before the next turn. Skip when you're just sending fresh work or waiting on a turn — those use `tm send` / `tm wait`, not `tm compact`.

## Check fill: `tm ctx`

How full is a teammate's context window? `tm ctx <repo>` (or `tm ctx --all`) reads the jsonl transcript and reports real prompt size — do not rely on the TUI status-bar percentage (approximate, often absent).

Reports the most recent assistant turn's prompt size (`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`), a next-turn estimate (plus that turn's `output_tokens`), and the percentage of the context window. Window size isn't recorded in the transcript: a peak usage above ~210k proves a 1M window, otherwise `tm ctx` assumes 200k and labels it `assumed 200k`. Pass `--window 200k|1m` when you know the window and the heuristic can't yet tell.

## The verb

```
tm compact <repo> [--timeout N]
```

Sends `/compact` to the teammate, waits for the **PostCompact** hook to fire (touches the idle marker), and prints `compacted` on stdout when the marker arrives. Default timeout is 600 s — large contexts (~300 k+) routinely take 3–4 minutes to compact, so the cap is generous on purpose.

**Run in background.** Compaction blocks for minutes; pair every `tm compact` with `run_in_background: true` on the Bash tool. (Same rule as every other long-running wait — see SKILL.md "Long-running waits".)

Run `tm compact --help` for full flag/output contract.

## Two non-success modes (different exit codes)

| Mode | Exit | What happened | How `tm compact` detects it |
|---|---|---|---|
| `"Not enough messages to compact"` | `1` | Transcript too short — Claude Code refuses up front | That error fires NO hook (won't satisfy the idle-marker poll), so the pane is scanned alongside the marker poll. On match, exits 1 immediately instead of hanging to `--timeout`. A true failure: `/compact` won't proceed. |
| PostCompact never fires within `--timeout` | `124` | Compaction may still be running, or the Stop hook is misconfigured | Falls through to the timeout cap and exits `124` (sync wait expired, teammate still alive) — same semantics as `tm send` / `tm wait` hitting `--timeout`. Don't respawn or kill on this code; the compaction is likely just taking longer than the cap. Re-run `tm wait <repo>` to keep watching, or check `tm status <repo>` to confirm the pane is still moving. |

The "Not enough messages" detection is the reason `tm compact` exists as its own verb instead of being a thin wrapper over `tm send <repo> --prompt /compact` — the wrapper would hang to 600 s on the transcript-too-short case (no hook, no error pane scan).

## Why `tm compact` doesn't echo ctx

After compaction, you almost always want to see the new ctx size — but `tm compact` deliberately does **not** print it. Two reasons:

1. The post-compact jsonl usage block isn't reliably present at the moment PostCompact fires; reading too early gets the pre-compact size.
2. Coupling makes the contract muddy — `tm compact`'s success is the single signal "marker touched", clean and binary.

Run `tm ctx <repo>` separately after `compacted` lands on stdout. Or do nothing — the next `tm send` will echo the post-turn ctx to stderr as part of its normal contract.

## Why `tm compact` exists as its own verb

`tm compact` is purpose-built for compaction because two things make a thin `tm send <repo> --prompt /compact` wrapper insufficient:

- **PostCompact produces no `.last` text** — fires the idle marker, so the wait does unblock, but stdout would be just the sentinel `(no text reply this turn — tool-only, /compact, /clear, or fresh spawn)`. `tm compact` prints a clean `compacted` line instead.
- **The "Not enough messages to compact" rejection fires no hook at all** — a generic send would block to `--timeout` (default 600 s) waiting for a Stop that never comes. `tm compact` scans the pane for that error alongside the marker poll and exits 1 immediately when it matches.

`tm send <repo> --prompt /compact` is exactly the wrapper that misses both — reach for `tm compact <repo>` for compaction.
