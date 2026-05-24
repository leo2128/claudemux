# Wait for a turn and read it back (scenario reference)

Read this when an external actor (Remote Control web UI, mobile app, a cron callback, the teammate's own sub-agents) is driving a teammate and you need to collect the result without sending a fresh prompt. Skip when YOU are the one sending — `tm send` and `tm spawn --prompt` already wait + print the reply atomically (see `dispatch-task.md`).

This file is also the authoritative writeup of the idle/.last hook machinery — every wait verb consumes those artifacts, so anything that touches the Stop-hook signal indirectly will cite back here.

## Primary verb: `tm wait --fresh <repo>`

```
tm wait <repo> [--fresh] [--pane-quiet] [--timeout N]
```

Blocks until the teammate's next Stop hook fires, then prints the reply to stdout — same output contract as `tm send` (including the post-turn ctx echo to stderr), and the same exit-code split: `0` reply landed, `124` sync wait expired but the teammate is still running (just re-run `tm wait`; the marker for the next Stop will arrive eventually), `1` true failure.

On Codex teammates, `tm wait` runs `thread/read` (with `includeTurns: true`) alongside the live notification subscription and races the two. If a turn completed in the gap between a previous `tm send` timing out (124) and the new wait subscribing, the snapshot finds it and the wait resolves with that turn instead of the next one — so the 124 → `tm wait` recovery promise actually holds for Codex, not just for Claude.

**Always pass `--fresh`** for passive observation. Without it, the idle marker from the *previous* Stop is still on disk and `tm wait` returns instantly. `--fresh` clears the idle/.last/.busy baseline up front so the wait targets the NEXT Stop. `tm send` does this baseline-reset internally before sending; passive observers have to ask for it explicitly.

**Run in background.** `tm wait` blocks for up to `--timeout 600` (default) — like every long-running wait, run it with `run_in_background: true` so the dispatcher stays free. The harness fires a task-notification when Stop arrives with the reply already in stdout.

Run `tm wait --help` for full flag/output contract.

## How the wait actually works (idle / .last hook machinery)

Two on-disk files per teammate power every wait verb (`tm wait`, `tm send`, `tm spawn --prompt`, `tm compact`):

- `/tmp/claude-idle/<sid>` — zero-byte touch, the idle signal. The plugin's `on-stop.sh` hook touches it on **Stop**, **StopFailure**, **PostCompact**, and **SessionEnd**.
- `/tmp/claude-idle/<sid>.last` — plain text of the assistant's last turn, written by `on-stop.sh` **on Stop only** (the other three events touch the idle marker without writing `.last`, since they don't correspond to a settled assistant turn).

`tm send` and `tm spawn --prompt` clear both files (plus `<sid>.busy`) before sending so the wait that follows targets THIS turn's outcome, not a leftover from a prior turn. `tm wait --fresh` does the same baseline-reset without sending.

`.last` is the full assistant text as recorded in the jsonl transcript; every wait verb reads `.last` instead of `tmux capture-pane` because the pane scrollback buffer truncates at the configured pane history limit, silently clipping long replies.

The hook fires for every Claude Code session (including the dispatcher itself), but that's harmless — nothing ever waits on the dispatcher's own sid. After publishing a plugin change, use `tm reload --all` to fan `/reload-plugins` out to every running teammate (the dispatcher itself still needs `/reload-plugins` typed manually).

`/hooks` slash-command UI only surfaces tool-related hooks (PreToolUse / PostToolUse / etc.) — Stop hooks do **not** appear in that menu but still fire. Don't conclude "hook missing" from the `/hooks` UI alone; check `~/.claude/settings.json` directly and watch for `/tmp/claude-idle/<sid>` getting touched.

## TUI-only commands and the `--pane-quiet` fallback

The Stop hook covers Stop / StopFailure / PostCompact / SessionEnd — so `/compact`, `/clear`, and API errors all unblock the default `tm send` / `tm wait` correctly. The atomic verbs are the right answer for those paths.

The narrow case that needs pane-quiet detection is **TUI-only slash commands and dialogs that fire NO hook at all**: `/help`, `/effort`, `/agents` opening dialogs, permission prompts. For those, pass `--pane-quiet` to either `tm send` (sends the command, then waits for the pane to settle) or `tm wait` (passive observe of pane-quiet without sending):

```bash
tm send <repo> --prompt /help --pane-quiet
```

It polls the pane and returns when the spinner has been absent for ~4 s AND at least 3 s have passed since the last send. `--fresh` is a no-op under `--pane-quiet` (the "≥3 s since last send" gate already provides the freshness guarantee). The ctx-echo to stderr is skipped on `--pane-quiet` too (no fresh usage block in jsonl).

Known blind spot: a permission prompt blocks claude with no spinner. `--pane-quiet` returns "ready" but the teammate is actually stuck on a y/n decision. If you suspect a prompt, follow with `tm status <repo>` to see the pane.

## Two foot-guns

- **Don't read `/tmp/claude-idle/<sid>` directly to check "done"** — `tm send` removes the marker before sending, so an old completed turn isn't visible there. That's by design. Use `tm wait --fresh` (which polls the same file and is what `tm send` itself uses internally), or `tm last <repo>` to re-read the printed text.
- **Don't build a custom polling loop with `grep` on prompt-echo words** — match expected RESULT keywords (`Scheduled`, `Cancelled`, error codes you anticipate), never words from the prompt you just sent. The prompt appears in the user turn, so a prompt-word grep returns instantly and the wait is meaningless. This is also why `tm wait`'s hook-driven approach is preferred over `tm poll`.

## A reply may cite instructions you never saw

The user can drive a teammate directly — Remote Control web UI, the mobile app — on a channel the dispatcher has no window into. A reply that references an instruction, decision, or constraint you never dispatched is therefore the expected case, not an anomaly: the user most likely gave it to the teammate on that direct channel.

Treat such references as genuine user input. Don't assume the teammate invented them, and don't "correct" the teammate back to what you remember dispatching. If a cited instruction genuinely conflicts with something you need to act on and can't be reconciled, ask the user — never overwrite the teammate's account of what the user told it.
