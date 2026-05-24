# Phase 1 — Bug audit for the 0.8.1+unreleased local install

Snapshot of what's broken (or just *looks* broken) at HEAD `dcc1636` on
`next`. Each entry is **observation → evidence → root cause → proposed
fix**, ordered by the priority the user named:
codex prefix > SessionStart hook > MCP > anything else.

---

## A. Codex engine selection via `codex-` name prefix

- **Observation.** `tm spawn <name>` forks on whether `<name>` starts with
  `codex-` to decide engine. The user named this as the load-bearing
  redesign of this iteration.
- **Evidence.** `isCodexTarget` is defined at
  [`plugins/claudemux/core/src/engines/codex/verbs.ts`](/plugins/claudemux/core/src/engines/codex/verbs.ts) and
  used at four sites in `native.ts` (`1149`, `2051`, `2310`, `2445`) plus
  the `codexAsk` pool filter in `plugins/claudemux/core/src/engines/codex/verbs.ts`.
- **Root cause.** [Decision 0022 §1](/.agents/decisions/0022-codex-driver.md)
  committed to the prefix as a one-helper-four-call-sites stage-4
  shortcut. The shortcut is now load-bearing surface contract — the cost
  is in the four-character namespace carve-out, the silent demotion of
  any teammate named `codex-…`, and the absence of a clean growth path
  for a third engine.
- **Proposed fix.** A new explicit `--engine <claude|codex>` flag at
  `tm spawn`, with engine identity persisted in the existing two
  per-teammate registries (no new files), a resolver that supersedes
  `isCodexTarget`, and a one-minor deprecation window for the prefix.
  Full rationale + alternatives in
  [decision 0023 (draft)](/.agents/decisions/0023-codex-engine-flag.md).

---

## B. SessionStart hook "did not fire" warning is a false alarm

- **Observation.** `tm spawn claudemux-doc` printed
  `WARN: claudemux-doc … did not signal ready within 18s (no SessionStart
  hook fire — the plugin's on-session-start.sh may not be loaded …)`. The
  user reasonably read that as "the hook is not loaded".
- **Evidence.** The hook *did* fire — it was just one second past the
  poll budget:
  - `/tmp/teammate-claudemux-doc.cwd` mtime `2026-05-23 21:17:01` (written
    by `tm spawn`).
  - `/tmp/teammate-claudemux-doc.sid` mtime `2026-05-23 21:17:01` (written
    by `tm spawn`).
  - `/tmp/teammate-claudemux-doc.ready` mtime `2026-05-23 21:17:20`.
    Only the hook touches this file (`tm spawn` only `rm`s it — see
    [`engines/claude/spawn.ts`](/plugins/claudemux/core/src/engines/claude/spawn.ts)
    and
    [`hooks/on-session-start.sh:90`](/plugins/claudemux/hooks/on-session-start.sh)),
    so its 19-second-later mtime is direct evidence of the hook running.
  - Hook produces `/tmp/claude-idle/_on-stop.log` actively — on-stop is
    firing for the dispatcher session every Stop, confirming `hooks.json`
    loaded cleanly (the bundle is "all or nothing"; the same JSON wires
    SessionStart and Stop).
- **Root cause.** `pollReady` in
  [`engines/claude/spawn.ts`](/plugins/claudemux/core/src/engines/claude/spawn.ts)
  loops 60 × 300 ms = **18 s**. Booting Opus 4.7 on a 1 M context window with a stack of
  user-scope plugins consistently takes ~19 s on this machine, so the
  poll loses by a single iteration. The WARN copy then misleads by
  hypothesising a load failure.
- **Proposed fix.** Two-part, both required:
  1. **Raise the poll budget** to ~36 s (120 × 300 ms). The window is for
     `claude` to print its first prompt and the hook to fire once — any
     value short of "claude is definitely wedged" is acceptable; 36 s is
     comfortable for the slowest observed cold boot without being a
     surprising wait when it *is* wedged.
  2. **Rewrite the WARN copy** so it describes what was actually observed,
     not a speculative cause. Replace the "may not be loaded" sentence
     with "claude has not signalled ready in `Ns` — it may still be
     starting (1 M context, plugin discovery) or wedged on a permission
     dialog. The verb continues; subsequent `tm send` / `wait` will
     surface a real hang."
- **on-stop sibling check.** Decisively **not** affected by the same
  root cause. Evidence: `_on-stop.log` shows the dispatcher's
  `9eceb6b9-…` session writing on every Stop in the last hour;
  `on-stop.sh` is reached via the same `hooks.json`, so if it loaded for
  one event it loaded for all. This teammate's own first Stop hasn't
  landed yet (no `<sid>.last` for the current sid `3b127467`), so we'll
  observe it once the first turn finishes — but there is no known route
  for hook bundles to load partially.

---

## C. "1 MCP server failed" — not a claudemux bug

- **Observation.** This REPL's status bar reports `1 MCP server failed`.
- **Evidence.** The Claude CLI log directory
  `~/Library/Caches/claude-cli-nodejs/-Users-bytedance-Development-claudemux-doc/`
  holds per-server logs. The latest connect attempt for each server in
  this session (`3b127467-…`):

  | MCP server | failure mode | shipped by |
  |---|---|---|
  | `claude-ai-Gmail` | `mcp_unauthorized_no_token` (OAuth not configured) | claude.ai Connectors |
  | `claude-ai-Google-Calendar` | `mcp_unauthorized_no_token` | claude.ai Connectors |
  | `claude-ai-Google-Drive` | `mcp_unauthorized_no_token` | claude.ai Connectors |
  | `plugin-devops-codebase` | `code.byted.org/…` unreachable (`go get` EOF) | `devops@evolve-up` |
  | `plugin-devops-meego` | `Failed to open SSE stream: Not Found` | `devops@evolve-up` |

  The claudemux-shipped `plugin-feishu-channel-feishu` has **no
  2026-05-23 log file at all** under this cwd; the most recent entry is
  `2026-05-21T09:11Z`, before this session started. That's correct: the
  `feishu-channel` plugin's entry in the user's
  `~/.claude/plugins/installed_plugins.json` has `scope: project` with
  `projectPath: /Users/bytedance/Development/claudemux` (the dispatcher),
  so it is not enabled for this teammate's cwd `…/claudemux-doc`. Nothing
  claudemux ships is failing.
- **Root cause.** Cosmetic Claude Code reporting: the status bar
  aggregates *five* failed servers down to "1 MCP server failed" — the
  count and the message are both misleading. The failures themselves are
  external (claude.ai OAuth not configured, ByteDance-internal Git host
  unreachable from this network, devops Meego SSE endpoint 404).
- **Proposed fix.** None inside claudemux. Hand the punch list above to
  the user so they can: (a) authorise the claude.ai Connectors they
  actually want, (b) check whether the `devops@evolve-up` plugin still
  needs to be enabled on this cwd given the network reach issues. The
  Claude Code status-bar undercount is upstream; we can mention it in
  the GitHub issue tracker but it does not block this iteration.

---

## D. Smaller things noticed in passing

- **`feishu` MCP cwd alignment.** As above, `feishu-channel` is enabled
  for the dispatcher only. If the dispatcher skill assumes "teammates
  inherit the feishu channel", that assumption is wrong — but a quick
  scan of the dispatcher skill doesn't show such an assumption. Flag for
  follow-up only if a real workflow trips on it.
- **`tm spawn`'s deprecation-warning path doesn't yet exist.** Today
  `tm spawn codex-1` succeeds silently; the proposed `--engine` change
  (item A) introduces the first deprecation warning surface in `tm`. The
  warning channel is stderr, alongside the existing `spawned: …` /
  `ready: …` lines — no new conventions needed.
- **`isCodexTarget` is exported.** It's used externally (`native.ts`
  imports it from `plugins/claudemux/core/src/engines/codex/verbs.ts`). When item A lands, the export goes
  away and the resolver in `paths.ts` takes its place. Caught here so
  the implementer doesn't preserve a backwards-compat re-export by
  habit.

---

## Approval gates

The user asked for *bug list + codex redesign* before any implementation.
The deliverables for this gate are:

1. **This file** — Phase 1 bug audit (`.agents/proposals/phase-1-bug-audit.md`).
2. **Decision 0023 draft** — the `--engine` flag design
   (`.agents/decisions/0023-codex-engine-flag.md`, status: `Proposed`).

Nothing in `plugins/claudemux/` has been edited. The proposal does not
ship.
