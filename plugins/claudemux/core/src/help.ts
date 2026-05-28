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
export const OVERVIEW_HELP = `tm — teammate manager for the dispatcher skill

Run \`tm <verb> --help\` (or \`tm help <verb>\`) for per-verb detail.

NAMING (after the schema 2 cut)
  Teammates have flat opaque identifiers (\`<name>\`). The source repo
  is the spawn-time \`<path>\` positional, recorded in identity, and
  reachable through \`tm ls\`'s REPO column. \`tm send <name>\`,
  \`tm kill <name>\`, etc. are name-based — no path coupling.

USAGE  (most common first)
  tm spawn <path> [--name <id>] [--prompt "..."] [--no-worktree]
                                         launch a teammate in <path>. Default
                                         creates a git worktree at
                                         <path>/.claude/worktrees/<name>/.
                                         --no-worktree keeps the teammate at
                                         <path> itself. --name overrides the
                                         auto-generated \`<path-leaf>-<rand4>\`
                                         (must be globally unique).
  tm send <name> --prompt "..."          atomic round-trip: send + wait + print reply
  tm wait <name> [--fresh]               wait for next Stop; print reply
  tm compact <name>                      /compact + verify, prints "compacted"
  tm resume <name> [<sid/thread-id>]     resume a prior conversation
  tm last <name> [--verbose]             reprint last reply; Codex raw turn with --verbose
  tm kill <name>                         graceful /exit (clean worktree auto-removed);
                                         dirty worktree preserved with stderr note
  tm reload <name>... | --all            fan out /reload-plugins
  tm ls                                  list teammates (NAME REPO WORKTREE ENGINE STATE)
  tm states                              rich fleet snapshot
  tm ctx <name>... | --all               real ctx-window usage from jsonl
  tm history <name> [<sid/thread-prefix>] inspect past sessions for this teammate
  tm mem <name>                          cat the parent repo's auto-memory index
  tm archive <id>                        move finished task active→archive (stdin)
  tm ask "<prompt>"                      one-shot turn on an idle codex teammate (pool)

DIAGNOSTIC (escape hatches — prefer the verbs above)
  tm status <name>                       capture-pane the teammate's live screen
  tm poll <name> <regex>                 block until pane matches
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
                       when unset. \`tm spawn <path>\` resolves a relative
                       <path> against this directory.
`

/** Per-verb help text — `tm <verb> --help` and `tm help <verb>` both print this. */
export const HELP_TEXTS: Readonly<Record<string, string>> = {
  ls: `tm ls

      List running teammate-<name> sessions. Shows tmux's raw session
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
  spawn: `tm spawn <path> [--name <id>] [--engine claude|codex] [--prompt "..."] [--no-worktree] [--timeout N]

      Launch a teammate in <path>. <path> is positional; it may be
      absolute, or relative to the dispatcher dir
      (TM_DISPATCHER_DIR / $PWD). The path must be an existing
      directory — it is \`realpath\`-resolved and recorded as
      \`identity.repo\` so every subsequent verb (\`tm send\`,
      \`tm kill\`, \`tm last\`, \`tm mem\`, …) routes by NAME without
      re-walking the filesystem.

      <name> conventions (after the schema 2 cut):
        - \`--name <id>\` is an explicit flat identifier. Allowed
          shape: \`^[A-Za-z0-9][A-Za-z0-9_-]*$\`. Must be globally
          unique across the dispatcher; collisions fail with
          \`already exists\`.
        - Omit \`--name\` and the verb auto-generates
          \`<path-leaf>-<rand4>\`. The leaf is derived from
          \`basename(realpath(<path>))\`; rand4 ensures multiple
          teammates can target the same repo without collision.

      Default behaviour creates a git worktree at
      \`<path>/.claude/worktrees/<name>/\` and runs the teammate
      inside it (branch \`worktree-<name>\`, base ref HEAD). Pass
      \`--no-worktree\` to keep the teammate at <path> itself —
      useful for repo-wide work where a worktree would be a
      negative-value isolation.

      Without --prompt, the verb returns once the REPL signals
      SessionStart (typically 2-4s on a warm Mac). With
      \`--prompt "..."\`, the verb sleeps 3s after ready, sends the
      prompt, waits for Stop, and prints the teammate's first-turn
      reply on stdout — atomic bootstrap, one call.

      \`--engine\` selects the teammate engine at spawn time. Default
      is claude; pass \`--engine codex\` for a Codex daemon teammate.
      The name carries no engine meaning, so \`codex-reviewer\` is a
      Claude teammate unless \`--engine codex\` is set. Codex
      teammates default to a self-managed git worktree at the same
      \`.claude/worktrees/<name>/\` layout; they are not tmux sessions,
      and \`--resume\` / \`--task\` are rejected on that path.

      Every teammate launches with the \`AskUserQuestion\` tool
      disabled — a teammate runs with no human at its terminal, and
      that modal would hold the turn open. A teammate raises
      questions by ending its turn with text, which \`tm send\` /
      \`tm spawn --prompt\` relays straight back to the dispatcher.

      Exit codes on the \`--prompt\` sync path:
        0   first-turn reply
        124 sync wait expired (teammate still booted — collect with
            \`tm wait <name>\`; don't respawn, the name is taken)
        1   real failure
`,
  send: `tm send <name> --prompt "..." [--pane-quiet] [--timeout N]

      Atomic round-trip by default: send prompt + wait for the Stop
      hook + print the teammate's reply text on stdout. The
      dispatcher's primary verb — folds what used to be send +
      wait-idle + last into one call. Stdout is exclusively reply
      text; status lines go to stderr (pipe-friendly).
      <name> is the flat teammate identifier from \`tm spawn\` /
      \`tm ls\` — never a path.
      --prompt "..." the prompt text. Required. Same calling form
        as 'tm spawn --prompt' / 'tm resume --prompt'. Flag order is
        free: 'tm send <name> --prompt "..."' and 'tm send --prompt
        "..." <name>' both work.
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
      of W (note)" — same data as 'tm ctx <name>' inline with the
      reply. Skipped on --pane-quiet (no fresh usage path in jsonl).
      Exit codes:
        0   the reply landed within --timeout; stdout is the reply.
        124 sync wait expired (no Stop hook within --timeout) but the
            teammate is STILL running — stdout is the partial .last
            if any, stderr names the verb to keep tailing with.
            Don't respawn; the name is still taken. Re-collect with
            'tm wait <name>' or check 'tm status <name>'.
        1   real failure (no such tmux session, sid marker missing,
            sendKeys broke). The teammate is gone or never started.

      When <name> is a codex teammate (recorded in the identity JSON),
      this verb routes into the codex driver: --prompt is
      required, --timeout is accepted, stdout is the final assistant
      text (same pipe-friendly contract as Claude), stderr carries
      sent/sid/ctx/raw-path status lines, and --pane-quiet is rejected
      explicitly rather than silently ignored. The raw Codex Turn JSON
      is atomically overwritten at
      /tmp/teammate-codex/<name>/last-turn.json and can be read with
      'tm last <name> --verbose'.
`,
  wait: `tm wait <name> [timeout=1800] [--fresh] [--pane-quiet] [--timeout N]

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
  compact: `tm compact <name> [timeout=1800] [--timeout N]

      Send /compact and verify PostCompact fired. Prints "compacted"
      on stdout when the Stop-hook idle marker is touched. Doesn't
      read ctx — run 'tm ctx <name>' separately if you want the new
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
  resume: `tm resume <name> [<sid-or-thread-id>] [--prompt "..."] [--engine claude|codex]

      Resume a prior conversation. <name> is the flat teammate
      identifier from a previous spawn — never a path.
      Claude teammates use a transcript sid: passing <sid> validates
      that transcript and launches 'claude --resume <sid>'. Without
      sid, Claude's native 'claude --continue' chooses the latest
      session for the cwd; the /tmp/teammate-<name>.sid marker is
      written by the SessionStart hook after the REPL starts.
      Codex teammates use a thread id: passing <thread-id> calls
      thread/resume directly. Without thread id, claudemux starts a new
      app-server daemon, calls thread/list(limit=1, sortKey=updated_at,
      cwd=<recorded-cwd>) to ask Codex for the latest thread, writes
      that thread id back to the Codex registry, and then calls
      thread/resume.
      Engine selection without an explicit id: when the teammate has no
      base record left (e.g. after 'tm kill'), claudemux probes the cwd
      against both engines' history (Claude project dir + Codex rollout
      sessions). A single candidate auto-routes; if both engines hold
      resumable history the verb refuses to guess and asks for
      disambiguation. Pass --engine claude|codex to skip probing and
      route directly, or supply an explicit <sid>/<thread-id>. --engine
      overrides every other selector — even an active router record.
      Fails if a teammate session for <name> already exists.
      --prompt sends a follow-up after relaunch, atomic like
      'tm spawn --prompt' (inherits 'tm send''s stderr ctx echo on
      the sync path where available).
      Like every teammate launch, the resumed REPL starts with the
      AskUserQuestion tool disabled (see 'tm help spawn' for why): a
      resumed teammate raises questions by ending its turn with
      text, not by opening a modal.
`,
  last: `tm last <name> [--verbose]

      Print the teammate's last-turn reply from
      /tmp/claude-idle/<sid>.last. Empty or missing file dies with
      "no reply yet". Use this when you want to re-read a reply the
      send/wait verbs already printed (their output is one-shot).
      For a Codex teammate, --verbose prints the raw
      /tmp/teammate-codex/<name>/last-turn.json instead of the
      assistant-text summary.
`,
  mem: `tm mem <name>

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
  kill: `tm kill <name>

      Graceful teammate shutdown. For a Claude teammate the verb
      sends \`/exit\` to the REPL and waits up to 15s for the
      SessionEnd hook to fire (observed as either the tmux pane
      disappearing or the teammate's idle marker being touched by
      \`on-stop.sh\`, whichever comes first). \`/exit\` in a clean
      worktree auto-removes both the worktree directory and the
      \`worktree-<slug>\` branch; in a dirty worktree Claude shows
      an interactive "Keep / Remove worktree" prompt — the verb
      presses Enter (default: Keep) and waits another 5s. If
      neither signal lands inside that 20s combined budget, the
      verb falls back to \`tmux kill-session\` (SIGHUP) and prints
      a stderr note pointing at the leftover worktree.

      Override the combined budget via \`CLAUDEMUX_KILL_GRACE_MS\`
      (used by the conformance harness to keep test runs fast).

      For a Codex teammate the verb SIGTERMs the daemon. When the
      identity record carries a \`worktreeSlug\`, the verb tries
      \`git worktree remove --force <name>/.claude/worktrees/<slug>\`;
      a dirty worktree is preserved with a stderr warning and a
      hand-typeable removal command.

      The identity JSON, \`.sid\` / \`.cwd\` / \`.ready\` / \`.send-at\`
      marker files, and idle / busy / .last markers are cleared on
      every exit path (clean, dirty, forced).
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
  reload: `tm reload <name>... | --all

      Fan out /reload-plugins to one, many, or every teammate.
      Sugar over 'tm send <name> --prompt /reload-plugins'. --all enumerates
      from \`tmux ls\`; missing/dead teammates are skipped with a
      stderr note and the exit status reflects whether every send
      succeeded.
`,
  ctx: `tm ctx <name>... | --all [--window 200k|1m]

      Real context-window usage per teammate, read from the jsonl
      usage block (more accurate than the TUI percentage). Prints
      current prompt size, next-turn estimate, and percent of
      window.
      Window size is not in the transcript: a peak above ~210k
      proves a 1M window; otherwise 200k is assumed (labelled
      accordingly). --window forces the assumption.
`,
  history: `tm history <name> [<sid-or-thread-prefix>]

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
  status: `tm status <name> [lines=80]

      Capture-pane the teammate's live screen. DIAGNOSTIC — the
      sync send/wait verbs make this unnecessary for normal flow.
      Reach for it only when you genuinely need the live pane (e.g.
      confirming a TUI dialog is up).
`,
  poll: `tm poll <name> <regex> [timeout=180]

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
  'wait-quiet': `tm wait-quiet was folded into the --pane-quiet flag in 0.3.0. Use 'tm wait <name> --pane-quiet' (or 'tm send <name> --prompt "..." --pane-quiet' for the send-then-wait composition).
`,
}
