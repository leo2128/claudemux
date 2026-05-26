# Wait for a turn and read it back (scenario reference)

Read this when an external actor (Remote Control web UI, mobile app, or the teammate's own sub-agents) is driving a teammate and you need to collect the result without sending a fresh prompt. Skip when you are the sender; `tm send` and `tm spawn --prompt` already wait and print the result atomically (see `dispatch-task.md`).

## Primary verbs

```bash
tm wait <repo> [timeout=1800] [--fresh] [--pane-quiet] [--timeout N]
tm wait <codex-name> [timeout=1800] [--timeout N]
```

For Claude tmux teammates, pass `--fresh` for passive observation. It clears the idle/.last/.busy baseline up front so the wait targets the next Stop, not a prior one. `tm send` does this reset internally before sending; passive observers have to ask for it explicitly.

For Codex daemon teammates, do not pass `--fresh` or `--pane-quiet`; current `tm wait` rejects both on Codex targets. Codex wait reads the current thread/turn state through the Codex driver and prints the Turn result on stdout.

`--timeout N` is the flag form of the positional timeout; both forms are accepted and the default is 1800 seconds. Run `tm wait` in the background so the dispatcher stays free. The harness fires a task notification when the result arrives.

Run `tm wait --help` for the full flag/output contract.

## Claude wait machinery: idle / .last files

Two on-disk files per Claude teammate power reply readback:

- `/tmp/claude-idle/<sid>` — zero-byte idle signal. The plugin's `on-stop.sh` hook touches it on **Stop**, **StopFailure**, **PostCompact**, and **SessionEnd**.
- `/tmp/claude-idle/<sid>.last` — assistant text from the last settled turn, written by `on-stop.sh` **on Stop only**.

`tm send`, `tm spawn --prompt`, and `tm wait` read `.last` for reply text. `tm compact` is different: it waits for the PostCompact idle marker and prints `compacted`; it does not read `.last`.

`tm send` and `tm spawn --prompt` clear both files plus `<sid>.busy` before sending so the following wait targets this turn. `tm wait --fresh` does the same baseline reset without sending.

`.last` is the full assistant text as recorded in the jsonl transcript. The verbs read it instead of `tmux capture-pane` because pane scrollback can silently clip long replies.

The Stop hook fires for every Claude Code session including the dispatcher; the dispatcher's sid is never waited on, so its hook firings are inert.

## TUI-only commands and the `--pane-quiet` fallback

The Stop hook covers Stop / StopFailure / PostCompact / SessionEnd, so `/compact`, `/clear`, and API errors unblock the default `tm send` / `tm wait` paths.

Use `--pane-quiet` only for Claude TUI-only slash commands and dialogs that fire no hook: `/help`, `/effort`, `/agents` opening dialogs, permission prompts. Example:

```bash
tm send <repo> --prompt /help --pane-quiet
```

It polls the pane and returns when the spinner has been absent for about 4 seconds and at least 3 seconds have passed since the last send. `--fresh` is a no-op under `--pane-quiet`; the send-at timing gate provides freshness. The ctx echo to stderr is skipped on `--pane-quiet` because there is no fresh usage block in jsonl.

Known blind spot: a permission prompt blocks Claude with no spinner. `--pane-quiet` can return "ready" while the teammate is stuck on a y/n decision. If you suspect a prompt, follow with `tm status <repo>` to see the pane.

## Two foot-guns

- **Don't read `/tmp/claude-idle/<sid>` directly to check "done".** `tm send` removes the marker before sending, so an old completed turn is not visible there. Use `tm wait --fresh` or `tm last <repo>`.
- **Don't build a custom polling loop with `grep` on prompt-echo words.** Match expected result keywords (`Scheduled`, `Cancelled`, anticipated error codes), never words from the prompt you just sent. The prompt appears in the user turn, so prompt-word grep returns instantly.

## Don't send extra input during a sync wait

While a `tm spawn --prompt`, `tm send`, or `tm wait` is still tracking a teammate's Stop, do not send that teammate any other input — no second `tm send`, no `/reload-plugins`, no `tm reload <repo>` aimed at it. An extra turn arriving mid-flight breaks `tm`'s Stop-signal capture: `/tmp/claude-idle/<sid>.last` never gets written, the tracking call never returns its reply, and you only learn the work finished by reading the artifact directly. `/reload-plugins` is the sharpest version because it reloads the Stop hook itself while a wait is depending on it.

Before sending anything to a teammate, check whether a background `tm` call is still tracking it (the ledger entry, the unfinished task notification). If one is, wait for it to return (or read the artifact directly) before the next send.

Fleet-wide operations such as `tm reload --all` should exclude any teammate currently tracked by a pending spawn/send — otherwise the in-flight wait silently dies on whichever teammate the fan-out hit.

## A reply may cite instructions you never saw

The user routinely drives Claude tmux teammates directly through Remote Control web UI, mobile, or claude.ai/code — channels the dispatcher cannot observe. A reply that references an instruction, decision, or constraint the dispatcher never sent is the expected case, not an anomaly.

The default reading is **"the user spoke to the teammate directly,"** not **"the teammate fabricated authorization."** Both are possible; in practice the former is almost always correct. How to act on it depends on how reversible the action is:

- **Reversible work** (a normal commit on a feature branch, an MR comment, a status read) — note the out-of-band channel in the ledger and continue. Do not "correct" the teammate back to what you remember dispatching, and do not write "user did not authorize this" / "fabricated" / "out of scope" in dispatcher-facing analysis without explicit user confirmation that they did not authorize it.
- **Irreversible work or shared-state work** (force-push, MR merge, branch deletion, secret rotation) — confirm with the user before raising alarm, and phrase it as a fact-check, not an accusation: "did you tell teammate X to do Y? I didn't see it on this side". Reflog and `git log` are still useful for understanding *what* happened; just do not auto-attribute intent to the teammate.

When you write a prompt whose effect spans multiple branches or repos (a force-push, a cleanup, an "amend"), be explicit about the target — an ambiguous dispatcher prompt can legitimately combine with explicit user direction on the out-of-band channel in unexpected ways.
