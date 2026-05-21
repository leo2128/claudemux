# Investigation: how to know a teammate's true model + context window

Question: with no `tm send` and no model turn, can `tm` determine each teammate's real model + window (1M vs 200k) so the `ctx` line stops defaulting to `assumed 200k`?

Probed on this host (macOS, Claude Code 2.1.144, Opus 4.7 [1m]):

## 1. Hook payloads — ❌ no model field

Inspected `jsonl` entries of type `system / stop_hook_summary` (the post-hook receipts) and the live hook payloads currently parsed by `on-stop.sh` / `on-busy.sh` / `on-session-start.sh`. Available keys: `session_id, transcript_path, hook_event_name, cwd, source, version, gitBranch, entrypoint, hookErrors, …`. **No `model`, no `context_window`, no `max_tokens`, no `betas`.** Anthropic does not surface model identity through any of the bound events.

## 2. jsonl transcript — ⚠️ base model only, no variant suffix

Every `assistant` entry has `.message.model`. Sampled values across this host's projects: `claude-opus-4-7`, `claude-opus-4-6`. **The `[1m]` variant suffix is stripped on persist** — the running session is the 1M variant per system prompt, but the on-disk model id is the base name. `.message.id` is per-message and carries no variant either. `.message.usage` has rich token detail but no window size. Conclusion: jsonl tells us the base SKU (useful for ruling out 1M for models that don't offer it, e.g. haiku-4-5) but **cannot distinguish 200k from 1M for models that offer both** (opus-4-7, sonnet-4-6).

## 3. Process layer — ⚠️ argv visible, but partial signal

`ps -ax -o command=` on macOS shows the claude argv. The teammate I sampled launched as: `claude --allow-dangerously-skip-permissions --resume <sid> --settings '{"claudeMdExcludes":[…]}'` — **no `--model`, no `--betas` flag**. The 1M variant was selected by the user's *runtime default* (interactive picker / `/model`), not by argv. So argv sniffing catches *only the spawn-time explicit choice*, missing both the implicit default and any later in-session `/model` switch. Linux `/proc/<pid>/environ` doesn't exist on macOS — no environment-level signal either.

## 4. Claude Code config / per-PID session files — ❌ no model

- `~/.claude/settings.json`: `.model = null` on this host despite running 1M variant. Not the source of truth.
- `~/.claude/sessions/<pid>.json`: keys `bridgeSessionId, cwd, entrypoint, kind, name, peerProtocol, pid, procStart, sessionId, startedAt, status, updatedAt, version`. **No `model`** in any of three sampled files.
- `~/.claude/projects/<encoded>/`: contains only the `<sid>.jsonl` transcripts and per-session subdirs. No sidecar metadata.

## 5. Official CLI exposure — ❌

`claude --help` lists `agents, auth, auto-mode, doctor, install, mcp, plugin, project, setup-token, ultrareview, update`. **None of them prints the running session's model or window.** `--model` and `--betas` are write-only flags; no read-back. No `claude info <sid>` exists.

---

## Two viable paths

### Path A — declarative at spawn (recommended)

(a) **Data**: extend `tm spawn` with `--window 1m|200k` (default: unset → keep current peak-heuristic fallback). Write the choice into a new `/tmp/teammate-<repo>.window` file alongside `.sid` / `.cwd` / `.ready` / `.send-at`. `_ctx_format_line` reads it first; if absent, falls back to the existing `peak > 210k` detection. (b) **tm 改动量**: 1 builder (`window_file()`), 1 flag in `cmd_spawn` argv parser, 4-line read in `_ctx_format_line`, 1 line in `cmd_kill` cleanup. ~25 lines. (c) **失败模式**: user forgets `--window 1m` and dispatcher sees `(assumed 200k)` until peak crosses 210k — identical to today. Mid-session `/model` switch isn't captured; dispatcher would need `tm window <repo> 1m` to retro-correct (5 more lines).

### Path B — PID-walk + argv sniff

(a) **Data**: `tmux list-panes -t teammate-<repo> -F '#{pane_pid}'` → walk children via `pgrep -P` → find the `claude` PID → `ps -p $pid -o command=` → grep for `--model.*\[1m\]` or `--betas.*context-1m`. (b) **tm 改动量**: ~40 lines; needs robust child-walking (macOS `pgrep -P` exists; tested). (c) **失败模式**: argv reflects spawn-time only — misses `/model` switches and the *implicit user default* path that produced our sample (no `--model` flag at all). On this host the technique would have returned "unknown" for the actively-running 1M session — i.e. the most common case.

---

## Recommendation: Path A (SUPERSEDED — see Documentation pass below)

Path B is information-poor in the dominant case (no `--model` flag, no `--betas`). Path A makes the dispatcher's intent the source of truth, which matches how it already chose the variant from the GUI. The same file (`/tmp/teammate-<repo>.window`) also gives us a place to record other per-teammate non-protocol metadata later (effort level, etc.), composing cleanly with the per-repo path-builder discipline. Keep the current peak-usage heuristic as the unset-fallback — it's not wrong, it's just slow to converge, and a one-flag opt-in is the cheapest way to make the common case correct from turn #1. As a small adjunct, **default to 200k unless either (a) `.window=1m`, (b) peak > 210k, or (c) jsonl `.message.model` ∈ {known-1M-only SKUs}** — that last clause costs one line and rules out future haiku-like 200k-only models from spurious 1M promotion.

---

# Documentation pass (official docs) — 2026-05-20

The investigation above was host-probing only — no official docs read. This pass closes that gap. **It overturns the recommendation: Path A is superseded by a new Path C.**

## Doc clue 1 — Hooks reference — ⚠️ partial

[code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks). Only `SessionStart` carries a model field; no hook carries window or token usage. Verbatim: *"Only SessionStart hooks receive a model field."* The value is the base SKU (`claude-sonnet-4-6`), no `[1m]`, no window. Confirms §1 of the first pass — hooks alone can't answer the window question.

## Doc clue 2 — Statusline reference — ✅ THE find

[code.claude.com/docs/en/statusline](https://code.claude.com/docs/en/statusline). The JSON piped to a statusline command on stdin contains a full `context_window` object **plus** `model.id`. Verbatim on the window field: *"context_window_size: 200000 by default, or 1000000 for models with extended context."* It also ships `context_window.used_percentage` *pre-calculated by Claude Code*, and `exceeds_200k_tokens`. This is Claude Code's **own authoritative window value** — it already accounts for plan-based 1M upgrades. The statusline runs after every assistant message + after `/compact`, locally, **consumes no API tokens, triggers no turn**, and applies to every session (teammates included) when configured in user `~/.claude/settings.json`.

## Doc clue 3 — CLI reference — ❌

`--model` / `--betas` are write-only flags; no documented read-back. No `claude info`/`claude config get model` that prints a *live* session's model or window.

## Doc clue 4 — Settings / model-config — ⚠️

[code.claude.com/docs/en/model-config](https://code.claude.com/docs/en/model-config). `model` / `availableModels` are write configs, often unset (host probe: `.model = null`). Claude Code derives the real window from model + plan: verbatim *"On Max, Team, and Enterprise plans, Opus is automatically upgraded to 1M."* That derived value is not in `settings.json` — it surfaces only through the statusline `context_window` object (clue 2).

## Doc clue 5 — Headless / SDK — ❌ for this use case

[code.claude.com/docs/en/headless](https://code.claude.com/docs/en/headless). `claude -p --output-format json` returns `usage` / `modelUsage`, but `-p` **runs a turn** — it violates the "no model turn" constraint. Not usable for passive polling.

## Verdict: Path A is superseded by Path C

### Path C — statusline sidecar (NEW RECOMMENDATION)

(a) **Data**: ship a small claudemux statusline script and register it in the user's `~/.claude/settings.json` `statusLine` field (via `scripts/setup.sh`, which already does settings.json merges). On each invocation it `jq`s `session_id`, `model.id`, `context_window.context_window_size`, `context_window.used_percentage` out of stdin and writes them to a sid-keyed sidecar, e.g. `/tmp/claude-idle/<sid>.ctx`. `tm`'s `_ctx_format_line` reads that file first — getting Claude Code's *own* window size and percentage — and only falls back to the jsonl heuristic if the sidecar is absent. (b) **tm 改动量**: new `statusline.sh` (~20 lines), `setup.sh` merge step (~30 lines), `_ctx_format_line` read (~10 lines), one `ctx_file()` path-builder. ~60–70 lines, 3 files. Medium. (c) **失败模式**: user/teammate has no statusline installed → falls back to today's heuristic, zero regression; `used_percentage` is `null` early-session and post-`/compact` → the sidecar still carries the correct `context_window_size` (window size never changes mid-session), so `tm` computes the % itself from the jsonl against the *right* denominator; an existing user statusline must be chained (claudemux's script writes the sidecar then delegates) — a real but solvable wrinkle.

### Why Path C beats the dispatcher's `/context` idea (Path D)

`/context` is a local TUI command — it fires no model turn, so it clears the "no turn" bar. And it is genuinely a teammate **self-report** of the true window, which is more accurate than Path A's dispatcher *guess*. But it is **not more accurate than Path C** — Path C's `context_window_size` is the very same number Claude Code renders inside `/context`, delivered as clean JSON. Path D additionally requires: `tmux send-keys` injecting into the teammate's input box (mutates teammate UI state), `capture-pane` scraping a human-formatted box, regex-parsing that box, and pane-quiet detection because the TUI command fires no hook. Every one of those is the brittle pane-scraping coupling the architecture review flagged. **Path C delivers the same authoritative value with none of the fragility and no teammate-state mutation.**

## Final recommendation

Adopt **Path C (statusline sidecar)**. It replaces Path A (declarative flag — a guess) and Path D (`/context` scraping — accurate but fragile and state-mutating). Path C reads Claude Code's own computed `context_window_size`, needs no model turn, refreshes automatically after every assistant message, and degrades cleanly to the existing heuristic when the statusline is not installed. Keep the jsonl peak-usage heuristic strictly as the no-sidecar fallback.
