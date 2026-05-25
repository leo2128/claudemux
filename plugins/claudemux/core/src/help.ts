/**
 * `tm` help text — the single source of truth for the human-facing CLI help.
 *
 * The Bash `bin/tm` is retired on the `next` line; help that used to come from
 * `cmd_help` and the per-verb `help_<verb>` heredocs lives here instead. The
 * text is byte-exact with what the bash help printed (every help line ends
 * with a newline, matching `cat <<'EOF'` semantics) so the conformance harness
 * can golden it without surprises and `tests/help` users see no UX drift.
 *
 * The CLI dispatch layer (`cli/dispatch.ts`) does the routing — this module
 * just owns the strings.
 */

/** Top-level synopsis — printed by `tm`, `tm help`, `tm --help`, `tm -h`. */
export const OVERVIEW_HELP = `tm — tmux teammate manager for the dispatcher skill

Run \`tm <verb> --help\` (or \`tm help <verb>\`) for per-verb detail.

USAGE  (most common first)
  tm send <repo> --prompt "..."          atomic round-trip: send + wait + print reply
  tm spawn <repo> [--prompt "..."]       launch teammate; --prompt = atomic bootstrap
  tm wait <repo> [--fresh]               wait for next Stop; print reply
  tm compact <repo>                      /compact + verify, prints "compacted"
  tm resume <repo> [<sid/thread-id>]     resume a prior conversation
  tm last <repo> [--verbose]             reprint last reply; Codex raw turn with --verbose
  tm kill <repo>                         kill the teammate's tmux session
  tm reload <repo>... | --all            fan out /reload-plugins
  tm ls                                  list running teammate sessions
  tm states                              one-line fleet snapshot
  tm ctx <repo>... | --all               real ctx-window usage from jsonl
  tm history <repo> [<sid/thread-prefix>] inspect past sessions for this repo
  tm mem <repo>                          cat sibling repo's auto-memory index
  tm archive <id>                        move finished task active→archive (stdin)
  tm ask "<prompt>"                      one-shot turn on an idle codex teammate (pool)

DIAGNOSTIC (escape hatches — prefer the verbs above)
  tm status <repo>                       capture-pane the teammate's live screen
  tm poll <repo> <regex>                 block until pane matches
  tm doctor                              self-check: tm path/version, env, tmux,
                                         idle dir, active teammates

HELP
  tm --help / tm -h / tm help            this text
  tm <verb> --help / tm help <verb>      detail for one verb

ENVIRONMENT
  TM_DISPATCHER_DIR    Dispatcher directory (parent of sibling repos).
                       scripts/setup.sh writes it into the dispatcher's
                       .claude/settings.json on first /claudemux:setup,
                       and Claude Code injects it as env at every
                       claude launch — so tm stays correct even when
                       the Bash tool's cwd drifts. Falls back to $PWD
                       when unset (backward compat for dispatchers set
                       up before this feature).
`

/** Per-verb help text — `tm <verb> --help` and `tm help <verb>` both print this. */
export const HELP_TEXTS: Readonly<Record<string, string>> = {
  ls: `tm ls

      List running teammate-<repo> sessions. Shows tmux's raw session
      row (name, window count, attached state). For a richer "who's
      doing what" view, prefer \`tm states\`.
`,
  states: `tm states

      One-line fleet snapshot: REPO, SID / thread id (first 8
      chars), BUSY, LAST (size + age of the last assistant reply),
      PREVIEW (first 50 chars of that reply). Claude reads
      /tmp/claude-idle/<sid>.last; Codex reads the current thread's
      rollout JSONL. Use to see what every teammate is doing at a
      glance.
`,
  spawn: `tm spawn <repo> [--engine claude|codex] [--task <slug>] [--prompt "..."]

      Launch a claude teammate in <dispatcher-dir>/<repo>, where the
      dispatcher dir comes from TM_DISPATCHER_DIR (or $PWD fallback);
      fails with "repo not found" if <repo> isn't a direct
      subdirectory of it.
      Without --prompt, returns once the REPL signals SessionStart
      (typically 2-4s on a warm Mac). With --prompt "...", sleeps 3s
      after ready, sends the prompt, waits for Stop, and prints the
      teammate's first-turn reply on stdout — atomic bootstrap, one
      call.
      --task <slug> names the conversation <repo>-<slug>. Allowlist:
      ASCII letters/digits + CJK Unified Ideographs (中日韩汉字).
      Without --task a fresh spawn auto-names <repo>-<rand4>.
      Fresh spawns also write an empty /tmp/claude-idle/<sid>.last
      sentinel, so 'tm last' before any reply returns a clear "no
      reply yet" error instead of stale content from an earlier sid.
      The --prompt sync path inherits 'tm send''s stderr ctx echo
      after the first-turn Stop.
      --engine selects the teammate engine at spawn time. Default is
      claude; pass --engine codex for a Codex daemon teammate. The name
      itself has no engine meaning, so codex-reviewer is a Claude
      teammate unless --engine codex is present.
      Codex teammates are not tmux sessions; --task and --resume are
      rejected on that path.
      Every teammate launches with the AskUserQuestion tool disabled
      (this applies to 'tm resume' too). A teammate runs with no
      human at its terminal, and that tool's modal holds the turn
      open so the Stop hook never fires — a sync verb would then
      block until --timeout. With the tool gone, a teammate raises
      questions by ending its turn with text, which 'tm send' /
      'tm spawn --prompt' relays straight back to the dispatcher.
      Exit codes on the --prompt sync path are inherited from
      'tm send': 0 first-turn reply, 124 sync wait expired (teammate
      still booted — collect with 'tm wait <repo>'; don't respawn
      because the name is taken), 1 real failure.
`,
  send: `tm send <repo> --prompt "..." [--pane-quiet] [--timeout N]

      Atomic round-trip by default: send prompt + wait for the Stop
      hook + print the teammate's reply text on stdout. The
      dispatcher's primary verb — folds what used to be send +
      wait-idle + last into one call. Stdout is exclusively reply
      text; status lines go to stderr (pipe-friendly).
      --prompt "..." the prompt text. Required. Same calling form
        as 'tm spawn --prompt' / 'tm resume --prompt'. Flag order is
        free: 'tm send <repo> --prompt "..."' and 'tm send --prompt
        "..." <repo>' both work.
      --pane-quiet falls back to pane-quiet detection. Use for
        TUI-only commands that fire no hook: /help, /effort,
        /agents, permission prompts. /compact and /clear do NOT
        need it — the Stop hook now covers them via PostCompact /
        SessionEnd.
      --timeout N overrides the 1800s default wait.
      Empty stdout never silently means success: a turn with no text
      (tool-only, /compact, /clear) prints the sentinel line "(no
      text reply this turn — tool-only, /compact, /clear, or fresh
      spawn)".
      On the default (Stop-hook) path, also echoes the teammate's
      post-turn ctx to stderr as "ctx: N tokens · ~M next turn · X%
      of W (note)" — same data as 'tm ctx <repo>' inline with the
      reply. Skipped on --pane-quiet (no fresh usage path in jsonl).
      Exit codes:
        0   the reply landed within --timeout; stdout is the reply.
        124 sync wait expired (no Stop hook within --timeout) but the
            teammate is STILL running — stdout is the partial .last
            if any, stderr names the verb to keep tailing with.
            Don't respawn; the name is still taken. Re-collect with
            'tm wait <repo>' or check 'tm status <repo>'.
        1   real failure (no such tmux session, sid marker missing,
            sendKeys broke). The teammate is gone or never started.

      When <repo> is a codex teammate (recorded in the identity JSON),
      this verb routes into the codex driver: --prompt is
      required, --timeout is accepted, stdout is the final assistant
      text (same pipe-friendly contract as Claude), stderr carries
      sent/sid/ctx/raw-path status lines, and --pane-quiet is rejected
      explicitly rather than silently ignored. The raw Codex Turn JSON
      is atomically overwritten at
      /tmp/teammate-codex/<name>/last-turn.json and can be read with
      'tm last <repo> --verbose'.
`,
  wait: `tm wait <repo> [timeout=1800] [--fresh] [--pane-quiet] [--timeout N]

      Block until the teammate's next Stop hook (or pane-quiet
      fallback), then print the reply to stdout — same output
      contract as 'tm send'. Use when an external actor (Remote
      Control web UI, mobile app, cron) drove the turn and you just
      want to collect the result.
      --fresh clears the idle/.last/.busy baseline up front so the
        NEXT Stop unblocks the wait, not a prior one. Required when
        monitoring an autonomously progressing teammate (no fresh
        'tm send' to reset the baseline for you). No-op under
        --pane-quiet (pane-quiet uses send-at timing instead of a
        sid-keyed marker; the "≥3s since last send" gate already
        provides the freshness guarantee).
      --pane-quiet falls back to pane-quiet detection (same use
        case as on 'tm send').
      --timeout N is the flag form of the positional [timeout=1800];
        both forms are accepted, and if both are passed, whichever
        is parsed last wins.
      Stop-hook path also echoes ctx to stderr (see 'tm send');
      skipped on --pane-quiet.
      Same exit codes as 'tm send': 0 on a fresh Stop, 124 if --timeout
      elapses without one (teammate still running — re-run 'tm wait'),
      1 on a real failure (no session / no sid marker).
`,
  compact: `tm compact <repo> [timeout=1800] [--timeout N]

      Send /compact and verify PostCompact fired. Prints "compacted"
      on stdout when the Stop-hook idle marker is touched. Doesn't
      read ctx — run 'tm ctx <repo>' separately if you want the new
      size.
      Default timeout is 1800s — large contexts can run many
      minutes, and the cap only fires when compaction never
      finishes.
      Two non-success modes with different exit codes:
        1   Claude Code refuses with "Not enough messages to compact"
            (transcript too short). That error fires no hook, so the
            pane is scanned alongside the idle-marker poll to detect
            it. /compact won't proceed; this is a true failure.
        124 PostCompact never fires within timeout. Compaction may
            still be running — same "sync wait expired, teammate
            still alive" semantics as 'tm send'.
`,
  resume: `tm resume <repo> [<sid-or-thread-id>] [--task <slug>] [--prompt "..."] [--engine claude|codex]

      Resume a prior conversation. Claude teammates use a transcript
      sid: passing <sid> validates that transcript and launches
      'claude --resume <sid>'. Without sid, Claude's native
      'claude --continue' chooses the latest session for the cwd; the
      /tmp/teammate-<repo>.sid marker is written by the SessionStart
      hook after the REPL starts.
      Codex teammates use a thread id: passing <thread-id> calls
      thread/resume directly. Without thread id, claudemux starts a new
      app-server daemon, calls thread/list(limit=1, sortKey=updated_at,
      cwd=<repo>) to ask Codex for the latest thread, writes that thread
      id back to the Codex registry, and then calls thread/resume.
      Engine selection without an explicit id: when the teammate has no
      base record left (e.g. after 'tm kill'), claudemux probes the cwd
      against both engines' history (Claude project dir + Codex rollout
      sessions). A single candidate auto-routes; if both engines hold
      resumable history the verb refuses to guess and asks for
      disambiguation. Pass --engine claude|codex to skip probing and
      route directly, or supply an explicit <sid>/<thread-id>. --engine
      overrides every other selector — even an active router record.
      Fails if a teammate session for <repo> already exists.
      --prompt sends a follow-up after relaunch, atomic like
      'tm spawn --prompt' (inherits 'tm send''s stderr ctx echo on
      the sync path where available). --task relabels the resumed
      conversation.
      Like every teammate launch, the resumed REPL starts with the
      AskUserQuestion tool disabled (see 'tm help spawn' for why): a
      resumed teammate raises questions by ending its turn with
      text, not by opening a modal.
`,
  last: `tm last <repo> [--verbose]

      Print the teammate's last-turn reply from
      /tmp/claude-idle/<sid>.last. Empty or missing file dies with
      "no reply yet". Use this when you want to re-read a reply the
      send/wait verbs already printed (their output is one-shot).
      For a Codex teammate, --verbose prints the raw
      /tmp/teammate-codex/<name>/last-turn.json instead of the
      assistant-text summary.
`,
  mem: `tm mem <repo>

      Cat the sibling repo's auto-memory MEMORY.md to stdout. Use
      this before composing a \`tm spawn\` / \`tm send --prompt\` that
      references sibling state (feature-gate names, branch names,
      in-progress projects) — sibling memories live in separate
      per-cwd index files that the dispatcher's own AutoMemory does
      not include. Resolves the encoded project dir as
      $HOME/.claude/projects/<encoded>/memory/MEMORY.md where
      <encoded> = the repo's physical cwd with every \`/\` and \`.\`
      replaced by \`-\`. If no MEMORY.md exists for the repo (never
      ran claude, or its project dir was pruned), prints a one-line
      notice to stderr and returns 0 with empty stdout — that is
      the normal "no sibling memory" case, not an error.

      MEMORY.md entries can be stale. Verify any fact you are about
      to inject into a teammate's prompt against current code or
      git state before sending.
`,
  kill: `tm kill <repo>

      Kill the teammate's tmux session and clean up its state files
      (/tmp/teammate-<repo>.{sid,send-at,ready,cwd}). A codex teammate
      reaps the codex daemon and its registry directory instead.
`,
  ask: `tm ask "<prompt>"

      Drive a one-shot turn on an idle codex teammate from the
      Codex pool, on a fresh thread (so the borrowed teammate's
      persistent conversation thread is not polluted). Prints the
      turn's JSON to stdout.

      Pool semantics (decision node-cli-orchestrator §6, pool decision A): the named
      Codex-engine teammates are the pool. ask picks any idle one,
      borrows it for one turn, and returns it. "Idle" means it has no
      active borrow lock; the lock is a file under
      /tmp/teammate-codex/<name>/lock.

      Errors when no codex teammate has been spawned, when every
      spawned teammate is dead (run 'tm doctor' to reap), or when
      every alive teammate is currently borrowed (retry, or spawn one
      more).
`,
  reload: `tm reload <repo>... | --all

      Fan out /reload-plugins to one, many, or every teammate.
      Sugar over 'tm send <repo> --prompt /reload-plugins'. --all enumerates
      from \`tmux ls\`; missing/dead teammates are skipped with a
      stderr note and the exit status reflects whether every send
      succeeded.
`,
  ctx: `tm ctx <repo>... | --all [--window 200k|1m]

      Real context-window usage per teammate, read from the jsonl
      usage block (more accurate than the TUI percentage). Prints
      current prompt size, next-turn estimate, and percent of
      window.
      Window size is not in the transcript: a peak above ~210k
      proves a 1M window; otherwise 200k is assumed (labelled
      accordingly). --window forces the assumption.
`,
  history: `tm history <repo> [<sid-or-thread-prefix>]

      Inspect this repo's past Claude sessions and Codex threads
      (live or dead). No id: list mode, newest-first table merged by
      transcript / rollout mtime. The ENGINE column identifies
      claude vs codex; ID is the full Claude sid (UUIDv4) or Codex
      thread id (UUIDv7) recorded in a rollout filename — the same
      string 'tm resume' accepts. '*' marks the current live
      teammate's session / thread. With a sid, thread id, or prefix:
      detail mode (full id, transcript / rollout path, size / line
      count, created time, ctx usage when present, first prompt,
      last assistant text up to 1500 chars, ready-to-paste
      'tm resume' command). Boundary vs 'tm last': last covers only
      the current live teammate's reply; history covers any jsonl on
      disk including killed sessions.
`,
  archive: `tm archive <id> [--status '<tag>']

      Move a finished task from the active ledger to the archive.
      Reads the compressed one/two-line outcome on stdin; copies
      repo/branch/intent verbatim from the active entry and stamps
      today's date. Prepends to dispatcher-tasks-archive.md (newest
      on top), creating it from its shape if absent, then deletes
      the entry from active-dispatcher-tasks.md. --status overrides
      the carried-over [status] tag.
`,
  status: `tm status <repo> [lines=80]

      Capture-pane the teammate's live screen. DIAGNOSTIC — the
      sync send/wait verbs make this unnecessary for normal flow.
      Reach for it only when you genuinely need the live pane (e.g.
      confirming a TUI dialog is up).
`,
  poll: `tm poll <repo> <regex> [timeout=180]

      Block until pane content matches a regex. DIAGNOSTIC fallback
      when \`tm wait\` can't catch an interesting intermediate state.
      Match the EXPECTED RESULT, not the prompt you just sent (a
      pattern that appears in the sent prompt makes the wait return
      instantly).
`,
  doctor: `tm doctor

      Self-check for the dispatcher environment. Reports, in order:
        - tm executable: resolved path and reported plugin version
        - dispatcher dir: TM_DISPATCHER_DIR (or $PWD fallback),
          whether the env was actually set, and whether the
          resolved path matches your current $PWD
        - tmux: installed? version? server running? are we inside
          a tmux session?
        - idle dir: does /tmp/claude-idle/ exist?
        - active teammates: count + names from \`tm ls\`
      Read-only — doesn't change any state. Use it when something
      looks off ("why is tm using the wrong path?" / "did
      /claudemux:setup actually write the env?"). Exit code is
      always 0; interpret the printed lines, not the status.
`,
}

/**
 * Verbs removed in earlier releases. A user (or stale doc) still typing them
 * gets a specific migration hint and exit 2, instead of the generic
 * "unknown subcommand" path — these are part of the user-facing contract.
 *
 * The `--help` pre-scan in `cli/parse.ts` runs first, so e.g. `tm ask --help`
 * still reaches the overview (no per-verb help exists for a removed verb) —
 * matching the bash behaviour that this layer preserves.
 */
export const REMOVED_VERB_MESSAGES: Readonly<Record<string, string>> = {
  // `tm ask` was removed in 0.3.0 and re-introduced in stage 4 with new
  // semantics (codex-mode borrow/return on a Codex-engine teammate). The
  // entry is therefore intentionally absent here — `cli/dispatch.ts` routes the
  // verb into the native dispatch table instead.
  'wait-idle': `tm wait-idle was renamed to 'tm wait' in 0.3.0. Same semantics; the new verb also prints .last on stdout by default.
`,
  'wait-quiet': `tm wait-quiet was folded into the --pane-quiet flag in 0.3.0. Use 'tm wait <repo> --pane-quiet' (or 'tm send <repo> --prompt "..." --pane-quiet' for the send-then-wait composition).
`,
}
