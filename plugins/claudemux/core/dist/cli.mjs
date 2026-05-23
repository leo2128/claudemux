#!/usr/bin/env node

// src/proc.ts
import { spawn } from "node:child_process";
function spawnCapture(argv, options) {
  return new Promise((resolve, reject) => {
    const [command, ...args] = argv;
    if (command === void 0) {
      reject(new Error("spawnCapture: empty argument vector"));
      return;
    }
    const child = spawn(command, args, {
      // `pipe` on all three streams, so `child.stdin/stdout/stderr` are the
      // non-null streams the capture below relies on.
      stdio: ["pipe", "pipe", "pipe"],
      env: options?.env ?? process.env,
      cwd: options?.cwd
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      });
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(options?.stdin ?? "");
  });
}

// src/column.ts
var runColumn = (input) => spawnCapture(["column", "-t", "-s", "	"], { stdin: input });

// src/grep.ts
var runGrep = async (pattern, input) => {
  const { code } = await spawnCapture(["grep", "-qE", pattern], { stdin: input });
  return code;
};

// src/help.ts
var OVERVIEW_HELP = `tm \u2014 tmux teammate manager for the dispatcher skill

Run \`tm <verb> --help\` (or \`tm help <verb>\`) for per-verb detail.

USAGE  (most common first)
  tm send <repo> --prompt "..."          atomic round-trip: send + wait + print reply
  tm spawn <repo> [--prompt "..."]       launch teammate; --prompt = atomic bootstrap
  tm wait <repo> [--fresh]               wait for next Stop; print reply
  tm compact <repo>                      /compact + verify, prints "compacted"
  tm resume <repo> [<sid>]               resume a prior conversation
  tm last <repo>                         reprint the last-turn reply
  tm kill <repo>                         kill the teammate's tmux session
  tm reload <repo>... | --all            fan out /reload-plugins
  tm ls                                  list running teammate sessions
  tm states                              one-line fleet snapshot
  tm ctx <repo>... | --all               real ctx-window usage from jsonl
  tm history <repo> [<sid-prefix>]       inspect past sessions for this repo
  tm mem <repo>                          cat sibling repo's auto-memory index
  tm archive <id>                        move finished task active\u2192archive (stdin)

DIAGNOSTIC (escape hatches \u2014 prefer the verbs above)
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
                       claude launch \u2014 so tm stays correct even when
                       the Bash tool's cwd drifts. Falls back to $PWD
                       when unset (backward compat for dispatchers set
                       up before this feature).
`;
var HELP_TEXTS = {
  ls: `tm ls

      List running teammate-<repo> sessions. Shows tmux's raw session
      row (name, window count, attached state). For a richer "who's
      doing what" view, prefer \`tm states\`.
`,
  states: `tm states

      One-line fleet snapshot: REPO, SID (first 8 chars), BUSY (yes
      if the .busy file from the on-busy hook is present), LAST
      (size + age of <sid>.last), PREVIEW (first 50 chars of last
      reply). Use to see what every teammate is doing at a glance.
`,
  spawn: `tm spawn <repo> [--task <slug>] [--prompt "..."] [--no-wait]

      Launch a claude teammate in <dispatcher-dir>/<repo>, where the
      dispatcher dir comes from TM_DISPATCHER_DIR (or $PWD fallback);
      fails with "repo not found" if <repo> isn't a direct
      subdirectory of it.
      Without --prompt, returns once the REPL signals SessionStart
      (typically 2-4s on a warm Mac). With --prompt "...", sleeps 3s
      after ready, sends the prompt, waits for Stop, and prints the
      teammate's first-turn reply on stdout \u2014 atomic bootstrap, one
      call. --no-wait combined with --prompt sends without waiting.
      --task <slug> names the conversation <repo>-<slug>. Allowlist:
      ASCII letters/digits + CJK Unified Ideographs (\u4E2D\u65E5\u97E9\u6C49\u5B57).
      Without --task a fresh spawn auto-names <repo>-<rand4>.
      Fresh spawns also write an empty /tmp/claude-idle/<sid>.last
      sentinel, so 'tm last' before any reply returns a clear "no
      reply yet" error instead of stale content from an earlier sid.
      The --prompt sync path inherits 'tm send''s stderr ctx echo
      after the first-turn Stop.
      Every teammate launches with the AskUserQuestion tool disabled
      (this applies to 'tm resume' too). A teammate runs with no
      human at its terminal, and that tool's modal holds the turn
      open so the Stop hook never fires \u2014 a sync verb would then
      block until --timeout. With the tool gone, a teammate raises
      questions by ending its turn with text, which 'tm send' /
      'tm spawn --prompt' relays straight back to the dispatcher.
`,
  send: `tm send <repo> --prompt "..." [--no-wait] [--pane-quiet] [--timeout N]

      Atomic round-trip by default: send prompt + wait for the Stop
      hook + print the teammate's reply text on stdout. The
      dispatcher's primary verb \u2014 folds what used to be send +
      wait-idle + last into one call. Stdout is exclusively reply
      text; status lines go to stderr (pipe-friendly).
      --prompt "..." the prompt text. Required. Same calling form
        as 'tm spawn --prompt' / 'tm resume --prompt'. Flag order is
        free: 'tm send <repo> --prompt "..."' and 'tm send --prompt
        "..." <repo>' both work.
      --no-wait fire-and-forget; return as soon as the keys are
        sent. Use for /clear before kill, or any case where the
        reply doesn't matter. (--pane-quiet has no effect with
        --no-wait, since nothing waits.)
      --pane-quiet falls back to pane-quiet detection. Use for
        TUI-only commands that fire no hook: /help, /effort,
        /agents, permission prompts. /compact and /clear do NOT
        need it \u2014 the Stop hook now covers them via PostCompact /
        SessionEnd.
      --timeout N overrides the 1800s default wait.
      Empty stdout never silently means success: a turn with no text
      (tool-only, /compact, /clear) prints the sentinel line "(no
      text reply this turn \u2014 tool-only, /compact, /clear, or fresh
      spawn)".
      On the default (Stop-hook) path, also echoes the teammate's
      post-turn ctx to stderr as "ctx: N tokens \xB7 ~M next turn \xB7 X%
      of W (note)" \u2014 same data as 'tm ctx <repo>' inline with the
      reply. Skipped on --pane-quiet (no fresh usage block in jsonl)
      and --no-wait (nothing waited).
      On timeout: stderr warning, partial .last to stdout if any,
      exit 1.
`,
  wait: `tm wait <repo> [timeout=1800] [--fresh] [--pane-quiet] [--timeout N]

      Block until the teammate's next Stop hook (or pane-quiet
      fallback), then print the reply to stdout \u2014 same output
      contract as 'tm send'. Use when an external actor (Remote
      Control web UI, mobile app, cron) drove the turn and you just
      want to collect the result.
      --fresh clears the idle/.last/.busy baseline up front so the
        NEXT Stop unblocks the wait, not a prior one. Required when
        monitoring an autonomously progressing teammate (no fresh
        'tm send' to reset the baseline for you). No-op under
        --pane-quiet (pane-quiet uses send-at timing instead of a
        sid-keyed marker; the "\u22653s since last send" gate already
        provides the freshness guarantee).
      --pane-quiet falls back to pane-quiet detection (same use
        case as on 'tm send').
      --timeout N is the flag form of the positional [timeout=1800];
        both forms are accepted, and if both are passed, whichever
        is parsed last wins.
      Stop-hook path also echoes ctx to stderr (see 'tm send');
      skipped on --pane-quiet.
`,
  compact: `tm compact <repo> [timeout=1800] [--timeout N]

      Send /compact and verify PostCompact fired. Prints "compacted"
      on stdout when the Stop-hook idle marker is touched. Doesn't
      read ctx \u2014 run 'tm ctx <repo>' separately if you want the new
      size.
      Default timeout is 1800s \u2014 large contexts can run many
      minutes, and the cap only fires when compaction never
      finishes.
      Two non-success modes, both exit 1:
        - Claude Code refuses with "Not enough messages to compact"
          (transcript too short). That error fires no hook, so the
          pane is scanned alongside the idle-marker poll to detect
          it.
        - PostCompact never fires within timeout. Compaction is
          hung or the Stop hook is misconfigured.
`,
  resume: `tm resume <repo> [<sid>] [--task <slug>] [--prompt "..."] [--no-wait]

      Resume a prior conversation. PREFER passing <sid> from the
      dispatcher's task ledger (active-dispatcher-tasks.md records
      the sid of each teammate it spawned). Without sid, picks the
      newest jsonl by mtime as a one-off convenience (stderr
      warning). Validates the jsonl exists in the project dir; UUID
      format enforced. Fails if a teammate session for <repo>
      already exists.
      --prompt sends a follow-up after a 3s settle, atomic like
      'tm spawn --prompt' (inherits 'tm send''s stderr ctx echo on
      the sync path). --no-wait (with --prompt) fires without
      waiting. --task relabels the resumed conversation.
      Like every teammate launch, the resumed REPL starts with the
      AskUserQuestion tool disabled (see 'tm help spawn' for why): a
      resumed teammate raises questions by ending its turn with
      text, not by opening a modal.
`,
  last: `tm last <repo>

      Print the teammate's last-turn reply from
      /tmp/claude-idle/<sid>.last. Empty or missing file dies with
      "no reply yet". Use this when you want to re-read a reply the
      send/wait verbs already printed (their output is one-shot).
`,
  mem: `tm mem <repo>

      Cat the sibling repo's auto-memory MEMORY.md to stdout. Use
      this before composing a \`tm spawn\` / \`tm send --prompt\` that
      references sibling state (feature-gate names, branch names,
      in-progress projects) \u2014 sibling memories live in separate
      per-cwd index files that the dispatcher's own AutoMemory does
      not include. Resolves the encoded project dir as
      $HOME/.claude/projects/<encoded>/memory/MEMORY.md where
      <encoded> = the repo's physical cwd with every \`/\` and \`.\`
      replaced by \`-\`. If no MEMORY.md exists for the repo (never
      ran claude, or its project dir was pruned), prints a one-line
      notice to stderr and returns 0 with empty stdout \u2014 that is
      the normal "no sibling memory" case, not an error.

      MEMORY.md entries can be stale. Verify any fact you are about
      to inject into a teammate's prompt against current code or
      git state before sending.
`,
  kill: `tm kill <repo>

      Kill the teammate's tmux session and clean up its state files
      (/tmp/teammate-<repo>.{sid,send-at,ready,cwd}).
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
  history: `tm history <repo> [<sid-or-prefix>]

      Inspect this repo's past Claude sessions (live or dead). No
      <sid>: list mode, newest-first table (SID, AGE, SIZE, TOPIC =
      first user prompt). '*' marks the current live teammate's
      session. With <sid> or 8+ char prefix: detail mode (full sid,
      file path, created/last-seen, ctx usage, first prompt, last
      assistant text up to 1500 chars, ready-to-paste 'tm resume'
      command). Boundary vs 'tm last': last covers only the current
      live teammate's reply; history covers any jsonl on disk
      including killed sessions.
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

      Capture-pane the teammate's live screen. DIAGNOSTIC \u2014 the
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
      Read-only \u2014 doesn't change any state. Use it when something
      looks off ("why is tm using the wrong path?" / "did
      /claudemux:setup actually write the env?"). Exit code is
      always 0; interpret the printed lines, not the status.
`
};
var REMOVED_VERB_MESSAGES = {
  ask: `tm ask was removed in 0.3.0. Use 'tm send <repo> --prompt "..."' \u2014 send is now sync round-trip by default and prints the reply on stdout.
`,
  "wait-idle": `tm wait-idle was renamed to 'tm wait' in 0.3.0. Same semantics; the new verb also prints .last on stdout by default.
`,
  "wait-quiet": `tm wait-quiet was folded into the --pane-quiet flag in 0.3.0. Use 'tm wait <repo> --pane-quiet' (or 'tm send <repo> --prompt "..." --pane-quiet' for the send-then-wait composition).
`
};

// src/native.ts
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join as join2 } from "node:path";

// src/paths.ts
import { join } from "node:path";
function idleDir() {
  return "/tmp/claude-idle";
}
function idleMarkerFor(sid) {
  return join(idleDir(), sid);
}
function busyMarkerFor(sid) {
  return join(idleDir(), `${sid}.busy`);
}
function lastFileFor(sid) {
  return join(idleDir(), `${sid}.last`);
}
function sidFile(repo) {
  return `/tmp/teammate-${repo}.sid`;
}
function cwdFile(repo) {
  return `/tmp/teammate-${repo}.cwd`;
}
function sendAtFile(repo) {
  return `/tmp/teammate-${repo}.send-at`;
}
function readyFile(repo) {
  return `/tmp/teammate-${repo}.ready`;
}
function encodeProjectDir(cwd) {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

// src/native.ts
var SESSION_PREFIX = "teammate-";
function die(message) {
  return { code: 1, stdout: "", stderr: `tm: ${message}
` };
}
function sessionField(line) {
  const colon = line.indexOf(":");
  return colon >= 0 ? line.slice(0, colon) : line;
}
var ls = async (_args, _options, env) => {
  let listing = "";
  try {
    listing = (await env.runTmux(["ls"])).stdout;
  } catch {
    listing = "";
  }
  const rows = listing.split("\n").filter((line) => sessionField(line).startsWith(SESSION_PREFIX));
  const text = rows.length > 0 ? `${rows.join("\n")}
` : "(no teammate sessions; use 'tm spawn <repo>')\n";
  return { code: 0, stdout: text, stderr: "" };
};
function resolveSid(repo) {
  try {
    const file = sidFile(repo);
    if (statSync(file).size === 0) return null;
    return readFileSync(file, "utf8").replace(/\n+$/, "");
  } catch {
    return null;
  }
}
function readIfNonEmpty(file) {
  try {
    if (statSync(file).size === 0) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
var last = async (args) => {
  const repo = args[0] ?? "";
  if (repo.length === 0) return die("usage: tm last <repo>");
  const sid = resolveSid(repo);
  if (sid === null) {
    return die(
      `no sid file for ${repo} at ${sidFile(repo)} \u2014 was this teammate spawned via 'tm spawn'? (raw 'tmux new-session' won't seed the sid)`
    );
  }
  const file = lastFileFor(sid);
  const reply = readIfNonEmpty(file);
  if (reply === null) {
    return die(
      `no reply yet for ${repo} (sid=${sid}) \u2014 file is missing or empty at ${file}. Try 'tm wait ${repo}' to block for the next Stop, or 'tm send ${repo} --prompt "..."' to drive a turn.`
    );
  }
  return { code: 0, stdout: reply, stderr: "" };
};
function usageInput(usage) {
  const num = (v) => typeof v === "number" ? v : 0;
  return num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens);
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readCtxUsage(jsonl) {
  let content;
  try {
    content = readFileSync(jsonl, "utf8");
  } catch {
    return null;
  }
  const inputs = [];
  let lastOut = 0;
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    if (entry === null) continue;
    if (!isPlainObject(entry)) return null;
    if (entry.type !== "assistant") continue;
    const message = entry.message;
    if (message === null || message === void 0) continue;
    if (!isPlainObject(message)) return null;
    const usage = message.usage;
    if (usage === null || usage === void 0) continue;
    if (!isPlainObject(usage)) return null;
    inputs.push(usageInput(usage));
    lastOut = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;
  }
  if (inputs.length === 0) return null;
  let peak = inputs[0];
  for (const value of inputs) if (value > peak) peak = value;
  return { used: inputs[inputs.length - 1], out: lastOut, peak };
}
function transcriptFile(projectsDir, cwd, sid) {
  return join2(projectsDir, encodeProjectDir(cwd), `${sid}.jsonl`);
}
function isRegularFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function ctxLine(repo, windowOverride, env) {
  const sid = resolveSid(repo);
  if (sid === null) return `${repo}: ? (no sid file)`;
  const recordedCwd = readIfNonEmpty(cwdFile(repo));
  const cwd = recordedCwd !== null ? recordedCwd.replace(/\n+$/, "") : `${env.dispatcherDir}/${repo}`;
  const jsonl = transcriptFile(env.projectsDir, cwd, sid);
  if (!isRegularFile(jsonl)) return `${repo}: ? (no transcript at ${jsonl})`;
  const usage = readCtxUsage(jsonl);
  if (usage === null) return `${repo}: ? (no assistant usage in transcript)`;
  const next = usage.used + usage.out;
  let window;
  let note;
  if (windowOverride === "1m") {
    window = 1e6;
    note = "flag";
  } else if (windowOverride === "200k") {
    window = 2e5;
    note = "flag";
  } else if (usage.peak > 21e4) {
    window = 1e6;
    note = "detected 1M";
  } else {
    window = 2e5;
    note = "assumed 200k";
  }
  const pct = Math.floor(usage.used * 100 / window);
  const wlabel = window >= 1e6 ? "1M" : "200k";
  return `${repo}: ${usage.used} tokens \xB7 ~${next} next turn \xB7 ${pct}% of ${wlabel} (${note})`;
}
async function iterRepos(runTmux2) {
  let listing = "";
  try {
    listing = (await runTmux2(["ls"])).stdout;
  } catch {
    listing = "";
  }
  const repos = [];
  for (const line of listing.split("\n")) {
    const field = sessionField(line);
    if (field.startsWith(SESSION_PREFIX)) repos.push(field.slice(SESSION_PREFIX.length));
  }
  return repos;
}
function parseCtxArgs(args) {
  const repos = [];
  let windowOverride = "";
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--all") {
      all = true;
    } else if (arg === "--window") {
      if (i + 1 >= args.length) return { error: { code: 1, stdout: "", stderr: "" } };
      windowOverride = args[i + 1];
      i++;
    } else if (arg.startsWith("--window=")) {
      windowOverride = arg.slice("--window=".length);
    } else if (arg.startsWith("-")) {
      return { error: die(`tm ctx: unknown flag: ${arg}`) };
    } else {
      repos.push(arg);
    }
  }
  if (windowOverride !== "" && windowOverride !== "200k" && windowOverride !== "1m") {
    return { error: die("tm ctx: --window must be 200k or 1m") };
  }
  return { repos, windowOverride, all };
}
var ctx = async (args, _options, env) => {
  const parsed = parseCtxArgs(args);
  if ("error" in parsed) return parsed.error;
  const repos = [...parsed.repos];
  if (parsed.all) repos.push(...await iterRepos(env.runTmux));
  if (repos.length === 0) {
    return die("usage: tm ctx <repo> [<repo>...] | --all  [--window 200k|1m]");
  }
  const lines = repos.map((repo) => ctxLine(repo, parsed.windowOverride, env));
  return { code: 0, stdout: `${lines.join("\n")}
`, stderr: "" };
};
function fmtAge(age) {
  if (age < 60) return `${age}s`;
  if (age < 3600) return `${Math.floor(age / 60)}m`;
  if (age < 86400) return `${Math.floor(age / 3600)}h`;
  return `${Math.floor(age / 86400)}d`;
}
function lastPreview(lastFile) {
  let content;
  try {
    content = readFileSync(lastFile, "utf8");
  } catch {
    return "(no first line)";
  }
  const preview = [...content.split("\n")[0] ?? ""].filter((ch) => (ch.codePointAt(0) ?? 0) > 31).slice(0, 50).join("");
  return preview.length > 0 ? preview : "(no first line)";
}
function statesRow(repo, now) {
  const sid = resolveSid(repo);
  const sidShort = sid === null ? "?" : sid.slice(0, 8);
  const busy = sid !== null && isRegularFile(busyMarkerFor(sid)) ? "yes" : "no";
  let last2 = "-";
  let preview = "-";
  if (sid !== null && sid.length > 0) {
    const lf = lastFileFor(sid);
    let stat;
    try {
      stat = statSync(lf);
    } catch {
      stat = null;
    }
    if (stat !== null && stat.size > 0) {
      const age = now - Math.floor(stat.mtimeMs / 1e3);
      last2 = `${stat.size}B/${fmtAge(age)}`;
      preview = lastPreview(lf);
    }
  }
  return [repo, sidShort, busy, last2, preview];
}
var states = async (_args, _options, env) => {
  const repos = await iterRepos(env.runTmux);
  if (repos.length === 0) return { code: 0, stdout: "(no teammate sessions)\n", stderr: "" };
  const now = Math.floor(Date.now() / 1e3);
  const rows = [
    ["REPO", "SID", "BUSY", "LAST", "PREVIEW"],
    ...repos.map((repo) => statesRow(repo, now))
  ];
  return env.runColumn(`${rows.map((row) => row.join("	")).join("\n")}
`);
};
function dieRepoNotFound(verb, repo, path, dispatcherDir) {
  if (isDirectory(join2(dispatcherDir, ".git"))) {
    return die(
      `${dispatcherDir} looks like a git working tree (.git exists), not a dispatcher root.
    The dispatcher dir should be the PARENT of your sibling repos.
    Try:  cd "${dirname(dispatcherDir)}" && tm ${verb} ${repo}
    (Or set TM_DISPATCHER_DIR in your dispatcher's .claude/settings.json
    \u2014 run /claudemux:setup to wire it up automatically.)`
    );
  }
  return die(
    `repo not found at ${path} \u2014 <repo> must be a direct subdirectory of the dispatcher dir (${dispatcherDir}). Dispatcher dir is read from TM_DISPATCHER_DIR (env) or $PWD; if it's wrong, set TM_DISPATCHER_DIR or run tm from the right place.`
  );
}
function projectDirForRepo(repo, env) {
  const phys = realpathSync(join2(env.dispatcherDir, repo));
  return join2(env.projectsDir, encodeProjectDir(phys));
}
var mem = async (args, _options, env) => {
  const repo = args[0] ?? "";
  if (repo.length === 0) return die("usage: tm mem <repo>");
  const path = join2(env.dispatcherDir, repo);
  if (!isDirectory(path)) return dieRepoNotFound("mem", repo, path, env.dispatcherDir);
  const mfile = join2(projectDirForRepo(repo, env), "memory", "MEMORY.md");
  if (!isRegularFile(mfile)) {
    return {
      code: 0,
      stdout: "",
      stderr: `tm mem: no auto-memory recorded for ${repo} (looked at ${mfile})
`
    };
  }
  return { code: 0, stdout: readFileSync(mfile, "utf8"), stderr: "" };
};
function toFixed1HalfEven(value) {
  const tenths = value * 10;
  const floor = Math.floor(tenths);
  const frac = tenths - floor;
  let rounded;
  if (frac < 0.5) rounded = floor;
  else if (frac > 0.5) rounded = floor + 1;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  return (rounded / 10).toFixed(1);
}
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${Math.trunc(bytes / 1024)}K`;
  if (bytes < 1073741824) return `${toFixed1HalfEven(bytes / 1048576)}M`;
  return `${toFixed1HalfEven(bytes / 1073741824)}G`;
}
function fmtLocalDateTime(epochSec) {
  const d = new Date(epochSec * 1e3);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function mungeCreated(ts) {
  return ts.replace("T", " ").replace(/\.[0-9]+Z?$/, "").replace(/Z$/, "");
}
function indent(text) {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}
function bashNum(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : 0;
}
function contentTextItems(content) {
  let hasText = false;
  const texts = [];
  for (const item of content) {
    if (!isPlainObject(item)) throw new Error("jq-fail");
    if (item.type === "text") {
      hasText = true;
      const t = item.text;
      if (t === null || t === void 0) texts.push("");
      else if (typeof t === "string") texts.push(t);
      else throw new Error("jq-fail");
    }
  }
  return hasText ? texts : null;
}
function userPromptText(entry) {
  const message = entry.message;
  if (message === null || message === void 0) return null;
  if (!isPlainObject(message)) throw new Error("jq-fail");
  if (message.role !== "user") return null;
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = contentTextItems(content);
    return texts === null ? null : texts.join(" ");
  }
  return null;
}
function historyUsageSum(usage) {
  if (!isPlainObject(usage)) throw new Error("jq-fail");
  let sum = null;
  for (const key of [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens"
  ]) {
    const value = usage[key];
    if (value === null || value === void 0) continue;
    if (typeof value !== "number") throw new Error("jq-fail");
    sum = (sum ?? 0) + value;
  }
  return sum;
}
function historyUsageStr(sum) {
  return sum === null ? "null" : String(sum);
}
function historyFirstPrompt(content) {
  for (const line of content.split("\n").slice(0, 200)) {
    if (line.trim() === "") continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(entry) || entry.type !== "user") continue;
    let text;
    try {
      text = userPromptText(entry);
    } catch {
      continue;
    }
    if (text === null) continue;
    return text.split("\n")[0] ?? "";
  }
  return "";
}
function historyTopic(content) {
  const stripped = [...historyFirstPrompt(content)].filter(
    (ch) => (ch.codePointAt(0) ?? 0) > 31
  );
  const topic = stripped.slice(0, 60).join("");
  return topic.length > 0 ? topic : "(no user prompt)";
}
var EMPTY_HISTORY = {
  firstPrompt: "",
  lastAssistant: "",
  createdTs: "",
  used: "",
  peak: ""
};
function readHistoryData(content) {
  try {
    const uPrompts = [];
    const aTexts = [];
    const usages = [];
    const timestamps = [];
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line);
      if (entry === null) continue;
      if (!isPlainObject(entry)) throw new Error("jq-fail");
      if (entry.type === "user") {
        const text = userPromptText(entry);
        if (text !== null) uPrompts.push(text);
      } else if (entry.type === "assistant") {
        const message = entry.message;
        if (message !== null && message !== void 0) {
          if (!isPlainObject(message)) throw new Error("jq-fail");
          if (Array.isArray(message.content)) {
            const texts = contentTextItems(message.content);
            if (texts !== null) aTexts.push(texts.join("\n"));
          }
          if (message.usage !== null && message.usage !== void 0) {
            usages.push(message.usage);
          }
        }
      }
      const ts = entry.timestamp;
      if (ts !== null && ts !== void 0) timestamps.push(ts);
    }
    let createdTs = "";
    if (timestamps.length > 0) {
      const first = timestamps[0];
      if (first === false) createdTs = "";
      else if (typeof first === "string") createdTs = first;
      else throw new Error("jq-fail");
    }
    let used = "";
    let peak = "";
    if (usages.length > 0) {
      const sums = usages.map(historyUsageSum);
      used = historyUsageStr(sums[sums.length - 1] ?? null);
      let peakNum = null;
      for (const sum of sums) {
        if (sum !== null && (peakNum === null || sum > peakNum)) peakNum = sum;
      }
      peak = historyUsageStr(peakNum);
    }
    return {
      firstPrompt: (uPrompts[0] ?? "").replace(/\n+$/, ""),
      lastAssistant: (aTexts[aTexts.length - 1] ?? "").replace(/\n+$/, ""),
      createdTs,
      used,
      peak
    };
  } catch {
    return EMPTY_HISTORY;
  }
}
async function historyList(repo, projectDir, env) {
  if (!isDirectory(projectDir)) {
    return { code: 0, stdout: `(no past sessions for ${repo})
`, stderr: "" };
  }
  let names;
  try {
    names = readdirSync(projectDir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    names = [];
  }
  if (names.length === 0) {
    return { code: 0, stdout: `(no past sessions for ${repo})
`, stderr: "" };
  }
  const files = names.map((name) => {
    let mtime = 0;
    try {
      mtime = Math.floor(statSync(join2(projectDir, name)).mtimeMs / 1e3);
    } catch {
      mtime = 0;
    }
    return { name, mtime };
  });
  files.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const liveSid = resolveSid(repo) ?? "";
  const now = Math.floor(Date.now() / 1e3);
  const rows = [[" ", "SID", "AGE", "SIZE", "TOPIC"]];
  for (const { name, mtime } of files) {
    const full = join2(projectDir, name);
    const sidFull = name.replace(/\.jsonl$/, "");
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      size = 0;
    }
    let content = "";
    try {
      content = readFileSync(full, "utf8");
    } catch {
      content = "";
    }
    const mark = liveSid !== "" && sidFull === liveSid ? "*" : " ";
    rows.push([
      mark,
      sidFull.slice(0, 8),
      fmtAge(now - mtime),
      fmtSize(size),
      historyTopic(content)
    ]);
  }
  return env.runColumn(`${rows.map((row) => row.join("	")).join("\n")}
`);
}
function historyDetail(repo, projectDir, prefix) {
  if (!/^[0-9a-f-]{1,36}$/.test(prefix)) {
    return die(
      `tm history: invalid sid prefix '${prefix}' \u2014 must match ^[0-9a-f-]{1,36}$`
    );
  }
  if (!isDirectory(projectDir)) {
    return die(`tm history: no project dir at ${projectDir} for ${repo} (no sessions yet)`);
  }
  let names;
  try {
    names = readdirSync(projectDir).filter(
      (name2) => name2.startsWith(prefix) && name2.endsWith(".jsonl") && isRegularFile(join2(projectDir, name2))
    );
  } catch {
    names = [];
  }
  names.sort();
  if (names.length === 0) {
    return die(`tm history: no session matching '${prefix}' in ${repo}`);
  }
  if (names.length > 1) {
    const cands = `${names.map((name2) => name2.replace(/\.jsonl$/, "")).join(" ")} `;
    return die(
      `tm history: prefix '${prefix}' matches ${names.length} sessions \u2014 be more specific: ${cands}`
    );
  }
  const name = names[0];
  const file = join2(projectDir, name);
  const sidFull = name.replace(/\.jsonl$/, "");
  let size = 0;
  let mtime = 0;
  try {
    const stat = statSync(file);
    size = stat.size;
    mtime = Math.floor(stat.mtimeMs / 1e3);
  } catch {
    size = 0;
    mtime = 0;
  }
  let content = "";
  try {
    content = readFileSync(file, "utf8");
  } catch {
    content = "";
  }
  const lineCount = (content.match(/\n/g) ?? []).length;
  const now = Math.floor(Date.now() / 1e3);
  const data = readHistoryData(content);
  const createdStr = data.createdTs !== "" ? mungeCreated(data.createdTs) : "";
  let ctxStr = "(no usage data)";
  if (data.used !== "" && data.peak !== "") {
    const window = bashNum(data.peak) > 21e4 ? 1e6 : 2e5;
    const pct = Math.trunc(bashNum(data.used) * 100 / window);
    const wlabel = window >= 1e6 ? "1M" : "200k";
    const note = window >= 1e6 ? "detected 1M" : "assumed 200k";
    ctxStr = `${data.used} tokens \xB7 ${pct}% of ${wlabel} (${note})`;
  }
  let laDisplay = data.lastAssistant !== "" ? data.lastAssistant : "(no assistant text)";
  if (data.lastAssistant !== "") {
    const cps = [...data.lastAssistant];
    if (cps.length > 1500) {
      laDisplay = `${cps.slice(0, 1500).join("")}
... (${cps.length - 1500} chars truncated; full text in jsonl)`;
    }
  }
  const fpDisplay = data.firstPrompt !== "" ? data.firstPrompt : "(no user prompt)";
  const stdout = `sid:        ${sidFull}
file:       ${file}
            (${fmtSize(size)} \xB7 ${lineCount} lines)
created:    ${createdStr !== "" ? createdStr : "(unknown)"}
last_seen:  ${fmtLocalDateTime(mtime)}  (${fmtAge(now - mtime)} ago)
ctx:        ${ctxStr}

first prompt:
${indent(fpDisplay)}

last assistant:
${indent(laDisplay)}

resume: tm resume ${repo} ${sidFull}
`;
  return { code: 0, stdout, stderr: "" };
}
var history = async (args, _options, env) => {
  const repo = args[0] ?? "";
  if (repo.length === 0) return die("usage: tm history <repo> [<sid-or-prefix>]");
  const path = join2(env.dispatcherDir, repo);
  if (!isDirectory(path)) return dieRepoNotFound("history", repo, path, env.dispatcherDir);
  const projectDir = projectDirForRepo(repo, env);
  const sidArg = args[1] ?? "";
  return sidArg === "" ? historyList(repo, projectDir, env) : historyDetail(repo, projectDir, sidArg);
};
async function requireSession(repo, runTmux2) {
  const name = `${SESSION_PREFIX}${repo}`;
  let exists = false;
  try {
    exists = (await runTmux2(["has-session", "-t", `=${name}`])).code === 0;
  } catch {
    exists = false;
  }
  return exists ? null : die(`no such teammate session: ${repo} (tmux=${name}; try 'tm ls')`);
}
async function resolvePaneTarget(repo, runTmux2) {
  const name = `${SESSION_PREFIX}${repo}`;
  let listing = "";
  try {
    listing = (await runTmux2(["list-sessions", "-F", "#{session_id} #{session_name}"])).stdout;
  } catch {
    listing = "";
  }
  for (const line of listing.split("\n")) {
    const space = line.indexOf(" ");
    if (space >= 0 && line.slice(space + 1) === name) return line.slice(0, space);
  }
  return "";
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var status = async (args, _options, env) => {
  const repo = args[0] ?? "";
  if (repo.length === 0) return die("usage: tm status <repo> [lines=80]");
  const lines = args[1] || "80";
  const sessionMissing = await requireSession(repo, env.runTmux);
  if (sessionMissing !== null) return sessionMissing;
  const pane = await resolvePaneTarget(repo, env.runTmux);
  if (pane === "") return die(`could not resolve pane target for ${repo}`);
  return env.runTmux(["capture-pane", "-t", pane, "-p", "-S", `-${lines}`]);
};
var poll = async (args, _options, env) => {
  const repo = args[0] ?? "";
  const pattern = args[1] ?? "";
  if (repo === "" || pattern === "") {
    return die("usage: tm poll <repo> <regex> [timeout=180]");
  }
  const timeoutArg = args[2] || "180";
  const sessionMissing = await requireSession(repo, env.runTmux);
  if (sessionMissing !== null) return sessionMissing;
  const pane = await resolvePaneTarget(repo, env.runTmux);
  if (pane === "") return die(`could not resolve pane target for ${repo}`);
  if (!isNonNegativeInteger(timeoutArg)) return { code: 1, stdout: "", stderr: "" };
  const end = Math.floor(Date.now() / 1e3) + Number(timeoutArg);
  while (Math.floor(Date.now() / 1e3) < end) {
    const capture = await env.runTmux(["capture-pane", "-t", pane, "-p", "-S", "-300"]);
    if (capture.code === 0 && await env.runGrep(pattern, capture.stdout) === 0) {
      return { code: 0, stdout: `matched: ${pattern}
`, stderr: "" };
    }
    await sleep(3e3);
  }
  return {
    code: 1,
    stdout: "",
    stderr: `tm: timeout after ${timeoutArg}s waiting for /${pattern}/ in ${repo}
`
  };
};
function clearIdle(sid) {
  if (sid === "") return;
  for (const file of [idleMarkerFor(sid), lastFileFor(sid), busyMarkerFor(sid)]) {
    rmSync(file, { force: true });
  }
}
var kill = async (args, _options, env) => {
  const repo = args[0] ?? "";
  if (repo.length === 0) return die("usage: tm kill <repo>");
  const name = `${SESSION_PREFIX}${repo}`;
  const sid = resolveSid(repo);
  if (sid !== null) clearIdle(sid);
  for (const file of [sidFile(repo), sendAtFile(repo), readyFile(repo), cwdFile(repo)]) {
    rmSync(file, { force: true });
  }
  let running = false;
  try {
    running = (await env.runTmux(["has-session", "-t", `=${name}`])).code === 0;
  } catch {
    running = false;
  }
  if (running) {
    await env.runTmux(["kill-session", "-t", `=${name}`]);
    return { code: 0, stdout: `killed: ${repo} (tmux=${name})
`, stderr: "" };
  }
  return { code: 0, stdout: `not running: ${repo} (tmux=${name})
`, stderr: "" };
};
var ARCHIVE_TEMPLATE = `${[
  "---",
  "name: dispatcher-tasks-archive",
  'description: "On-demand archive of closed dispatcher tasks, compressed to outcome + artifacts. NOT a boot read \u2014 only consult when looking up past task history. Live in-flight tasks live in active-dispatcher-tasks.md."',
  "metadata:",
  "  node_type: memory",
  "  type: project",
  "---",
  "",
  "# Dispatcher task archive",
  "",
  "Closed tasks moved here from `active-dispatcher-tasks.md`, compressed to a",
  "pointer + conclusion (not a knowledge base). Newest on top. Reusable analysis",
  "that outlives a task should be promoted to its own memory file, not kept here.",
  "",
  "<!-- split by month (dispatcher-tasks-archive-YYYY-MM.md) if this file grows past a few hundred entries -->"
].join("\n")}
`;
function fmtLocalDate() {
  const d = /* @__PURE__ */ new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function ledgerLines(content) {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function parseArchiveArgs(args) {
  let id = "";
  let status2 = "";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--status") {
      if (i + 1 >= args.length) return { error: { code: 1, stdout: "", stderr: "" } };
      status2 = args[i + 1];
      i++;
    } else if (arg.startsWith("--status=")) {
      status2 = arg.slice("--status=".length);
    } else if (arg.startsWith("-")) {
      return { error: die(`tm archive: unknown flag: ${arg}`) };
    } else if (id === "") {
      id = arg;
    } else {
      return { error: die(`tm archive: unexpected arg: ${arg}`) };
    }
  }
  return { id, status: status2 };
}
var archive = async (args, options, env) => {
  const parsed = parseArchiveArgs(args);
  if ("error" in parsed) return parsed.error;
  const { id } = parsed;
  if (id === "") {
    return die("usage: tm archive <id> [--status '<tag>']   (outcome text on stdin)");
  }
  const memoryDir = join2(env.projectsDir, encodeProjectDir(env.dispatcherDir), "memory");
  const activePath = join2(memoryDir, "active-dispatcher-tasks.md");
  const archivePath = join2(memoryDir, "dispatcher-tasks-archive.md");
  if (!isRegularFile(activePath)) return die(`no active ledger at ${activePath}`);
  const outcome = (options?.stdin ?? "").replace(/\n+$/, "");
  if (outcome.replace(/\s/g, "") === "") {
    return die(`outcome text required on stdin, e.g.:  echo '...' | tm archive ${id}`);
  }
  const activeContent = readFileSync(activePath, "utf8");
  const activeLines = ledgerLines(activeContent);
  let headerRe;
  try {
    headerRe = new RegExp(`^### ${id}(\\s|$)`);
  } catch {
    headerRe = /(?!)/;
  }
  const headerLines = activeLines.map((line, index) => headerRe.test(line) ? index + 1 : 0).filter((lineNo) => lineNo > 0);
  if (headerLines.length === 0) {
    const available = activeLines.map((line) => /^### [^ ]+/.exec(line)?.[0]).filter((match) => match != null).map((match) => match.slice("### ".length)).join(" ");
    return die(`id not found in active ledger: ${id}
  available: ${available}`);
  }
  if (headerLines.length !== 1) {
    return die(`id matches ${headerLines.length} entries in active ledger: ${id}`);
  }
  const start = headerLines[0];
  const total = (activeContent.match(/\n/g) ?? []).length;
  let end = total;
  for (let index = start; index < activeLines.length; index++) {
    if (/^(### |## )/.test(activeLines[index])) {
      end = index;
      break;
    }
  }
  const blockLines = activeLines.slice(start - 1, end);
  let status2 = parsed.status;
  if (status2 === "") {
    const tag = /\[(.+)\]\s*$/.exec(blockLines[0] ?? "");
    status2 = tag ? tag[1] : "done";
  }
  const field = (name) => {
    const line = blockLines.find((candidate) => candidate.startsWith(`- ${name}:`));
    if (line === void 0) return "(unknown)";
    const value = line.slice(`- ${name}:`.length).replace(/^\s*/, "");
    return value === "" ? "(unknown)" : value;
  };
  const entry = `### ${id}  [${status2}]
- repo/branch: ${field("repo")} / ${field("branch")}
- intent: ${field("intent")}
- outcome: ${outcome}
- closed: ${fmtLocalDate()}`;
  const archiveContent = isRegularFile(archivePath) ? readFileSync(archivePath, "utf8") : ARCHIVE_TEMPLATE;
  const archiveLines = ledgerLines(archiveContent);
  let firstEntry = 0;
  for (let index = 0; index < archiveLines.length; index++) {
    if (archiveLines[index].startsWith("### ")) {
      firstEntry = index + 1;
      break;
    }
  }
  let newArchive;
  if (firstEntry > 0) {
    const head = firstEntry > 1 ? `${archiveLines.slice(0, firstEntry - 1).join("\n")}
` : "";
    const tail = `${archiveLines.slice(firstEntry - 1).join("\n")}
`;
    newArchive = `${head}${entry}

${tail}`;
  } else {
    newArchive = `${archiveContent}
${entry}
`;
  }
  const remaining = [...activeLines.slice(0, start - 1), ...activeLines.slice(end)];
  const newActive = remaining.length > 0 ? `${remaining.join("\n")}
` : "";
  writeFileSync(archivePath, newArchive);
  writeFileSync(activePath, newActive);
  return {
    code: 0,
    stdout: `archived ${id}  [${status2}] -> dispatcher-tasks-archive.md  (removed from active ledger)
`,
    stderr: ""
  };
};
var reload = async (args, _options, env) => {
  let all = false;
  const repos = [];
  for (const arg of args) {
    if (arg === "--all") all = true;
    else if (arg === "-h" || arg === "--help") return die("usage: tm reload <repo>... | --all");
    else if (arg.startsWith("-")) return die(`tm reload: unknown flag: ${arg}`);
    else repos.push(arg);
  }
  if (all) {
    if (repos.length > 0) return die("tm reload: --all conflicts with explicit repos");
    repos.push(...await iterRepos(env.runTmux));
    if (repos.length === 0) {
      return { code: 0, stdout: "(no teammate sessions to reload)\n", stderr: "" };
    }
  } else if (repos.length === 0) {
    return die("usage: tm reload <repo>... | --all");
  }
  let stdout = "";
  for (const repo of repos) {
    stdout += `\u2192 ${repo}: /reload-plugins
`;
    const sent = await send(["--no-wait", repo, "--prompt", "/reload-plugins"], void 0, env);
    if (sent.code !== 0) return { code: sent.code, stdout, stderr: "" };
  }
  return { code: 0, stdout, stderr: "" };
};
function resolveSidOrDie(repo) {
  const sid = resolveSid(repo);
  if (sid === null) {
    return {
      error: die(
        `no sid file for ${repo} at ${sidFile(repo)} \u2014 was this teammate spawned via 'tm spawn'? (raw 'tmux new-session' won't seed the sid)`
      )
    };
  }
  return { sid };
}
function newSid() {
  return randomUUID().toLowerCase();
}
function randSuffix() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(4);
  let out = "";
  for (let i = 0; i < 4; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}
function sanitizeTaskSlug(task) {
  let s = task.toLowerCase();
  s = s.replace(/[^a-z0-9一-鿿]+/g, "-");
  s = s.replace(/^-+|-+$/g, "");
  const cps = [...s];
  if (cps.length > 30) {
    s = cps.slice(0, 30).join("");
    s = s.replace(/-+$/, "");
  }
  return s;
}
function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function nowSec() {
  return Math.floor(Date.now() / 1e3);
}
function isNonNegativeInteger(value) {
  return /^[0-9]+$/.test(value);
}
function readSendKeysConfig() {
  const inlineRaw = process.env.TM_SEND_INLINE_MAX ?? "";
  const inlineMax = inlineRaw === "" ? 200 : Number(inlineRaw);
  if (inlineRaw !== "" && !/^[0-9]+$/.test(inlineRaw)) {
    return die(
      `TM_SEND_INLINE_MAX must be a non-negative integer (got: '${inlineRaw}')`
    );
  }
  const gapRaw = process.env.TM_SEND_GAP ?? "";
  if (gapRaw !== "" && !/^[0-9]+(\.[0-9]+)?$/.test(gapRaw)) {
    return die(
      `TM_SEND_GAP must be a non-negative number of seconds (got: '${gapRaw}')`
    );
  }
  return {
    inlineMax,
    gapOverride: gapRaw === "" ? null : gapRaw
  };
}
function defaultPasteGapSec(promptLength) {
  if (promptLength <= 256) return 0.2;
  if (promptLength <= 1024) return 0.5;
  if (promptLength <= 4096) return 1;
  if (promptLength <= 16384) return 2;
  return 4;
}
async function sendKeys(repo, prompt, env) {
  const sessionMissing = await requireSession(repo, env.runTmux);
  if (sessionMissing !== null) return sessionMissing;
  const pane = await resolvePaneTarget(repo, env.runTmux);
  if (pane === "") return die(`could not resolve pane target for ${repo}`);
  const cfg = readSendKeysConfig();
  if ("code" in cfg) return cfg;
  const sid = resolveSid(repo);
  if (sid !== null) clearIdle(sid);
  const sa = sendAtFile(repo);
  mkdirSync(dirname(sa), { recursive: true });
  writeFileSync(sa, "");
  const n = prompt.length;
  const inlinePath = n <= cfg.inlineMax && !prompt.includes("\n");
  const name = `${SESSION_PREFIX}${repo}`;
  let stderr = `sent to ${repo} (tmux=${name})
`;
  if (sid !== null) stderr += `sid=${sid}
`;
  const tmuxOk = (result, what) => result.code === 0 ? null : die(`tmux ${what} failed: ${result.stderr.trim() || "non-zero exit"}`);
  if (inlinePath) {
    const sent = await env.runTmux(["send-keys", "-t", pane, "-l", prompt]);
    const sentErr = tmuxOk(sent, "send-keys");
    if (sentErr !== null) return sentErr;
    const enter = await env.runTmux(["send-keys", "-t", pane, "Enter"]);
    const enterErr = tmuxOk(enter, "send-keys Enter");
    if (enterErr !== null) return enterErr;
    return { code: 0, stdout: "", stderr };
  }
  const gap = cfg.gapOverride !== null ? Number(cfg.gapOverride) : defaultPasteGapSec(n);
  const buf = `tm-send-${process.pid}-${randomBytes(2).toString("hex")}`;
  let loaded = false;
  try {
    const loadResult = await env.runTmux(["load-buffer", "-b", buf, "-"], { stdin: prompt });
    const loadErr = tmuxOk(loadResult, "load-buffer");
    if (loadErr !== null) return loadErr;
    loaded = true;
    const pasteResult = await env.runTmux([
      "paste-buffer",
      "-p",
      "-r",
      "-d",
      "-b",
      buf,
      "-t",
      pane
    ]);
    const pasteErr = tmuxOk(pasteResult, "paste-buffer");
    if (pasteErr !== null) return pasteErr;
    loaded = false;
    await sleepMs(Math.round(gap * 1e3));
    const enter = await env.runTmux(["send-keys", "-t", pane, "Enter"]);
    const enterErr = tmuxOk(enter, "send-keys Enter");
    if (enterErr !== null) return enterErr;
  } finally {
    if (loaded) {
      try {
        await env.runTmux(["delete-buffer", "-b", buf]);
      } catch {
      }
    }
  }
  return { code: 0, stdout: "", stderr };
}
async function waitIdleSignal(repo, timeoutSec, fresh, env) {
  const sessionMissing = await requireSession(repo, env.runTmux);
  if (sessionMissing !== null) return sessionMissing;
  const sidR = resolveSidOrDie(repo);
  if ("error" in sidR) return sidR.error;
  if (fresh) clearIdle(sidR.sid);
  const end = nowSec() + timeoutSec;
  const marker = idleMarkerFor(sidR.sid);
  while (nowSec() < end) {
    if (existsSync(marker)) return { ok: true };
    await sleepMs(3e3);
  }
  return { ok: false };
}
async function waitPaneQuiet(repo, timeoutSec, env) {
  const sessionMissing = await requireSession(repo, env.runTmux);
  if (sessionMissing !== null) return sessionMissing;
  let sendAt = 0;
  try {
    const sa = sendAtFile(repo);
    sendAt = Math.floor(statSync(sa).mtimeMs / 1e3);
  } catch {
    sendAt = 0;
  }
  const end = nowSec() + timeoutSec;
  let quietStreak = 0;
  while (nowSec() < end) {
    const sid = resolveSid(repo);
    const isBusy = sid !== null && isRegularFile(busyMarkerFor(sid));
    if (isBusy) quietStreak = 0;
    else quietStreak += 1;
    if (quietStreak >= 2 && nowSec() - sendAt >= 3) return { ok: true };
    await sleepMs(2e3);
  }
  return { ok: false };
}
function printLastOrEmpty(repo) {
  const sid = resolveSid(repo);
  if (sid === null) return `(no sid for ${repo})
`;
  const reply = readIfNonEmpty(lastFileFor(sid));
  if (reply === null) {
    return "(no text reply this turn \u2014 tool-only, /compact, /clear, or fresh spawn)\n";
  }
  return reply;
}
function echoCtxToStderr(repo, env) {
  const body = ctxLine(repo, "", env);
  if (body.includes(": ? (")) return "";
  const prefix = `${repo}: `;
  const data = body.startsWith(prefix) ? body.slice(prefix.length) : body;
  return `ctx: ${data}
`;
}
var doctor = async (args, _options, env) => {
  if (args.length > 0) {
    return die(`tm doctor: takes no arguments (got: ${args.join(" ")})`);
  }
  const kv = (label, value) => {
    const padded = `${label}:`.padEnd(20, " ");
    return `  ${padded}${value}
`;
  };
  let out = "";
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const tmWrapper = join2(moduleDir, "..", "..", "bin", "tm");
  const pluginJson = join2(moduleDir, "..", "..", ".claude-plugin", "plugin.json");
  let version = "unknown";
  let pluginJsonPresent = false;
  try {
    if (statSync(pluginJson).isFile()) {
      pluginJsonPresent = true;
      const parsed = JSON.parse(readFileSync(pluginJson, "utf8"));
      if (typeof parsed.version === "string" && parsed.version.length > 0) {
        version = parsed.version;
      }
    }
  } catch {
    pluginJsonPresent = false;
  }
  out += "tm executable:\n";
  out += kv("path", tmWrapper);
  out += kv("version", version);
  if (!pluginJsonPresent) out += kv("note", `plugin.json not found at ${pluginJson}`);
  out += "\n";
  out += "dispatcher dir:\n";
  out += kv("resolved", env.dispatcherDir);
  const envSet = process.env.TM_DISPATCHER_DIR;
  if (envSet !== void 0 && envSet.length > 0) {
    out += kv("TM_DISPATCHER_DIR", `set (= ${envSet})`);
  } else {
    out += kv(
      "TM_DISPATCHER_DIR",
      "unset \u2014 falling back to $PWD (run /claudemux:setup to inoculate against cwd drift)"
    );
  }
  const pwd = process.cwd();
  out += kv("$PWD", pwd);
  if (env.dispatcherDir !== pwd) {
    out += kv(
      "status",
      "DIVERGED \u2014 dispatcher dir != $PWD; env override is currently keeping tm correct despite the drifted PWD"
    );
  } else {
    out += kv("status", "matched");
  }
  if (!isDirectory(env.dispatcherDir)) {
    out += kv("warning", `${env.dispatcherDir} does not exist as a directory`);
  }
  out += "\n";
  out += "tmux:\n";
  let tmuxVersionOk = false;
  let tmuxVersionLine = "";
  try {
    const versionResult = await env.runTmux(["-V"]);
    if (versionResult.code === 0) {
      tmuxVersionOk = true;
      tmuxVersionLine = versionResult.stdout.split("\n")[0] ?? "?";
    }
  } catch {
    tmuxVersionOk = false;
  }
  if (!tmuxVersionOk) {
    out += kv("installed", "no (tmux not on PATH \u2014 claudemux teammate workflow needs it)");
  } else {
    out += kv("installed", `yes (${tmuxVersionLine})`);
    let serverRunning = false;
    try {
      serverRunning = (await env.runTmux(["info"])).code === 0;
    } catch {
      serverRunning = false;
    }
    if (serverRunning) out += kv("server", "running");
    else out += kv("server", "not running (no sessions exist yet \u2014 that's fine pre-spawn)");
    const insideTmux = process.env.TMUX ?? "";
    if (insideTmux.length > 0) out += kv("in tmux", `yes (TMUX=${insideTmux})`);
    else out += kv("in tmux", "no \u2014 tm is being run from outside a tmux session");
  }
  out += "\n";
  out += `idle dir (${idleDir()}):
`;
  if (isDirectory(idleDir())) {
    let count = 0;
    try {
      count = readdirSync(idleDir()).length;
    } catch {
      count = 0;
    }
    out += kv("exists", `yes (${count} file(s))`);
  } else {
    out += kv("exists", "no \u2014 gets created on first tm spawn / scripts/setup.sh");
  }
  out += "\n";
  out += "active teammates:\n";
  let listing = "";
  try {
    listing = (await env.runTmux(["ls"])).stdout;
  } catch {
    listing = "";
  }
  const sessionRows = listing.split("\n").map((line) => sessionField(line)).filter((name) => name.startsWith(SESSION_PREFIX));
  if (sessionRows.length === 0) {
    out += "  (none \u2014 use 'tm spawn <repo>' to launch one)\n";
  } else {
    out += kv("count", String(sessionRows.length));
    for (const name of sessionRows) out += `  ${name}
`;
  }
  return { code: 0, stdout: out, stderr: "" };
};
function parseSpawnArgs(rest) {
  const SILENT = { code: 1, stdout: "", stderr: "" };
  let resumeSid = "";
  let task = "";
  let prompt = "";
  let hasPrompt = false;
  let noWait = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--resume") {
      if (i + 1 >= rest.length) return { error: SILENT };
      resumeSid = rest[i + 1];
      i++;
    } else if (arg === "--task") {
      if (i + 1 >= rest.length) return { error: SILENT };
      task = rest[i + 1];
      i++;
    } else if (arg.startsWith("--task=")) {
      task = arg.slice("--task=".length);
    } else if (arg === "--prompt") {
      if (i + 1 >= rest.length) return { error: die("tm spawn: --prompt requires a value") };
      prompt = rest[i + 1];
      hasPrompt = true;
      i++;
    } else if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length);
      hasPrompt = true;
    } else if (arg === "--no-wait") {
      noWait = true;
    } else {
      return { error: die(`unknown flag: ${arg}`) };
    }
  }
  return { resumeSid, task, prompt, hasPrompt, noWait };
}
function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function teammateLaunchFlags(mdExcludes) {
  return `--settings ${shellSingleQuote(mdExcludes)} --disallowedTools AskUserQuestion`;
}
async function sessionExists(name, runTmux2) {
  try {
    return (await runTmux2(["has-session", "-t", `=${name}`])).code === 0;
  } catch {
    return false;
  }
}
async function pollReady(repo) {
  const rf = readyFile(repo);
  for (let i = 1; i <= 60; i++) {
    if (existsSync(rf)) return i * 300;
    await sleepMs(300);
  }
  return null;
}
var spawn2 = async (args, _options, env) => {
  const repo = args[0] ?? "";
  if (repo.length === 0) {
    return die('usage: tm spawn <repo> [--task <slug>] [--prompt "..."] [--no-wait]');
  }
  const parsed = parseSpawnArgs(args.slice(1));
  if ("error" in parsed) return parsed.error;
  const { resumeSid, task, prompt, hasPrompt, noWait } = parsed;
  if (noWait && !hasPrompt) {
    return die(
      "tm spawn: --no-wait is only valid with --prompt (a fresh spawn without a prompt already returns as soon as the REPL is ready)"
    );
  }
  const path = join2(env.dispatcherDir, repo);
  if (!isDirectory(path)) return dieRepoNotFound("spawn", repo, path, env.dispatcherDir);
  const cwdPhys = realpathSync(path);
  const dispatcherPhys = realpathSync(env.dispatcherDir);
  const mdExcludes = JSON.stringify({
    claudeMdExcludes: [
      `${dispatcherPhys}/CLAUDE.md`,
      `${dispatcherPhys}/CLAUDE.local.md`
    ]
  });
  let displayName = "";
  if (task.length > 0) {
    const slug = sanitizeTaskSlug(task);
    if (slug.length === 0) {
      return die(
        `tm spawn: --task '${task}' has no usable characters after sanitization (allowlist: ASCII letters/digits + CJK Unified Ideographs)`
      );
    }
    displayName = `${repo}-${slug}`;
  } else if (resumeSid.length === 0) {
    displayName = `${repo}-${randSuffix()}`;
  }
  const name = `${SESSION_PREFIX}${repo}`;
  if (await sessionExists(name, env.runTmux)) {
    if (hasPrompt) {
      return die(
        `${repo} already exists (tmux=${name}) \u2014 atomic bootstrap rejected because the teammate is already running. Use 'tm send ${repo} --prompt "\u2026"' to drive an existing teammate, or 'tm kill ${repo}' first to start over.`
      );
    }
    return {
      code: 0,
      stdout: `${repo} already exists (tmux=${name}; use 'tm status ${repo}' to view, or 'tm kill ${repo}' first)
`,
      stderr: ""
    };
  }
  const rf = readyFile(repo);
  rmSync(rf, { force: true });
  const cf = cwdFile(repo);
  mkdirSync(dirname(cf), { recursive: true });
  writeFileSync(cf, `${cwdPhys}
`);
  let paneId = "";
  try {
    const newSession = await env.runTmux([
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      cwdPhys,
      "-e",
      `CLAUDEMUX_TEAMMATE_REPO=${repo}`,
      "-P",
      "-F",
      "#{session_id}"
    ]);
    if (newSession.code !== 0) {
      return die(`tmux new-session failed: ${newSession.stderr.trim() || newSession.stdout.trim()}`);
    }
    paneId = newSession.stdout.split("\n")[0] ?? "";
  } catch (err) {
    return die(`tmux new-session failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (paneId.length === 0) return die(`tmux new-session returned no session id for ${repo}`);
  const sid = resumeSid.length > 0 ? resumeSid : newSid();
  const launchFlags = teammateLaunchFlags(mdExcludes);
  const nameArg = displayName.length > 0 ? ` -n ${shellSingleQuote(displayName)}` : "";
  const launchCmd = resumeSid.length > 0 ? `claude --resume ${sid} ${launchFlags}${nameArg}` : `claude --session-id ${sid} ${launchFlags}${nameArg}`;
  await env.runTmux(["send-keys", "-t", paneId, launchCmd, "Enter"]);
  let stderr = "";
  if (resumeSid.length > 0) {
    const nameNote = displayName.length > 0 ? `, name=${displayName}` : "";
    stderr += `spawned: ${repo} (tmux=${name}, cwd=${cwdPhys}, resumed sid=${sid}${nameNote})
`;
  } else {
    const nameNote = displayName.length > 0 ? `, name=${displayName}` : "";
    stderr += `spawned: ${repo} (tmux=${name}, cwd=${cwdPhys}, sid=${sid}${nameNote})
`;
  }
  const sf = sidFile(repo);
  mkdirSync(dirname(sf), { recursive: true });
  writeFileSync(sf, `${sid}
`);
  clearIdle(sid);
  if (resumeSid.length === 0) {
    mkdirSync(idleDir(), { recursive: true });
    writeFileSync(lastFileFor(sid), "");
  }
  const readyAfter = await pollReady(repo);
  if (readyAfter !== null) {
    stderr += `ready: ${repo} (tmux=${name}, SessionStart fired after ~${readyAfter} ms)
`;
  } else {
    stderr += `WARN: ${repo} (tmux=${name}) did not signal ready within 18s (no SessionStart hook fire \u2014 the plugin's on-session-start.sh may not be loaded, or claude failed to boot). Continuing, but if the REPL is actually dead, a subsequent sync 'tm send' / 'tm spawn --prompt' / 'tm compact' will block until its --timeout expires (default 1800s). 'tm status ${repo}' shows the live pane if you need to verify.
`;
  }
  if (!hasPrompt) {
    return { code: 0, stdout: "", stderr };
  }
  await sleepMs(3e3);
  const sendArgs = [];
  if (noWait) sendArgs.push("--no-wait");
  sendArgs.push(repo, "--prompt", prompt);
  const sendResult = await send(sendArgs, void 0, env);
  return {
    code: sendResult.code,
    stdout: sendResult.stdout,
    stderr: stderr + sendResult.stderr
  };
};
function parseSendArgs(args) {
  let noWait = false;
  let paneQuiet = false;
  let timeout = "1800";
  let repo = "";
  let prompt = "";
  let hasPrompt = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--no-wait") {
      noWait = true;
      i++;
    } else if (arg === "--pane-quiet") {
      paneQuiet = true;
      i++;
    } else if (arg === "--timeout") {
      if (i + 1 >= args.length) return { error: die("tm send: --timeout requires a value") };
      timeout = args[i + 1];
      i += 2;
    } else if (arg.startsWith("--timeout=")) {
      timeout = arg.slice("--timeout=".length);
      i++;
    } else if (arg === "--prompt") {
      if (i + 1 >= args.length) return { error: die("tm send: --prompt requires a value") };
      prompt = args[i + 1];
      hasPrompt = true;
      i += 2;
    } else if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length);
      hasPrompt = true;
      i++;
    } else if (arg === "--") {
      i++;
      repo = args[i] ?? "";
      i++;
      break;
    } else if (arg.startsWith("-")) {
      return { error: die(`tm send: unknown flag: ${arg}`) };
    } else if (repo === "") {
      repo = arg;
      i++;
    } else {
      const tail = args.slice(i).join(" ");
      return {
        error: die(
          `tm send: prompt is now a --prompt flag, not a positional arg. Did you mean: tm send ${repo} --prompt ${shellSingleQuote(tail)} ?`
        )
      };
    }
  }
  return { repo, prompt, hasPrompt, noWait, paneQuiet, timeout };
}
var send = async (args, _options, env) => {
  const parsed = parseSendArgs(args);
  if ("error" in parsed) return parsed.error;
  const { repo, prompt, hasPrompt, noWait, paneQuiet, timeout } = parsed;
  if (repo === "") {
    return die(
      'tm send: missing <repo>. Usage: tm send <repo> --prompt "..." [--no-wait] [--pane-quiet] [--timeout N]'
    );
  }
  if (!hasPrompt) {
    return die(
      'tm send: missing --prompt. Usage: tm send <repo> --prompt "..." [--no-wait] [--pane-quiet] [--timeout N]'
    );
  }
  if (!isNonNegativeInteger(timeout)) {
    return die(`tm send: --timeout must be a non-negative integer (got: '${timeout}')`);
  }
  const sentResult = await sendKeys(repo, prompt, env);
  if (sentResult.code !== 0) return sentResult;
  if (noWait) return sentResult;
  const timeoutSec = Number(timeout);
  const verdict = paneQuiet ? await waitPaneQuiet(repo, timeoutSec, env) : await waitIdleSignal(repo, timeoutSec, false, env);
  if ("code" in verdict) return verdict;
  if (!verdict.ok) {
    const kind = paneQuiet ? "pane-quiet" : "Stop hook";
    return {
      code: 1,
      stdout: printLastOrEmpty(repo),
      stderr: sentResult.stderr + `tm send: timed out after ${timeout}s waiting for ${kind} on ${repo}
`
    };
  }
  let trailingStderr = "";
  if (!paneQuiet) trailingStderr = echoCtxToStderr(repo, env);
  return {
    code: 0,
    stdout: printLastOrEmpty(repo),
    stderr: sentResult.stderr + trailingStderr
  };
};
function parseWaitArgs(args) {
  const SILENT = { code: 1, stdout: "", stderr: "" };
  let repo = "";
  let timeout = "1800";
  let fresh = false;
  let paneQuiet = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--fresh") {
      fresh = true;
      i++;
    } else if (arg === "--pane-quiet") {
      paneQuiet = true;
      i++;
    } else if (arg === "--timeout") {
      if (i + 1 >= args.length) return { error: SILENT };
      timeout = args[i + 1];
      i += 2;
    } else if (arg.startsWith("--timeout=")) {
      timeout = arg.slice("--timeout=".length);
      i++;
    } else if (arg.startsWith("-")) {
      return { error: die(`tm wait: unknown flag: ${arg}`) };
    } else if (repo === "") {
      repo = arg;
      i++;
    } else {
      timeout = arg;
      i++;
    }
  }
  return { repo, timeout, fresh, paneQuiet };
}
var wait = async (args, _options, env) => {
  const parsed = parseWaitArgs(args);
  if ("error" in parsed) return parsed.error;
  const { repo, timeout, fresh, paneQuiet } = parsed;
  if (repo === "") {
    return die(
      "usage: tm wait <repo> [timeout=1800] [--fresh] [--pane-quiet] [--timeout N]"
    );
  }
  if (!isNonNegativeInteger(timeout)) {
    return die(`tm wait: --timeout must be a non-negative integer (got: '${timeout}')`);
  }
  const timeoutSec = Number(timeout);
  const verdict = paneQuiet ? await waitPaneQuiet(repo, timeoutSec, env) : await waitIdleSignal(repo, timeoutSec, fresh, env);
  if ("code" in verdict) return verdict;
  if (!verdict.ok) {
    return {
      code: 1,
      stdout: printLastOrEmpty(repo),
      stderr: `tm wait: timed out after ${timeout}s on ${repo}
`
    };
  }
  let trailingStderr = "";
  if (!paneQuiet) trailingStderr = echoCtxToStderr(repo, env);
  return {
    code: 0,
    stdout: printLastOrEmpty(repo),
    stderr: trailingStderr
  };
};
function parseCompactArgs(args) {
  const SILENT = { code: 1, stdout: "", stderr: "" };
  let repo = "";
  let timeout = "1800";
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--timeout") {
      if (i + 1 >= args.length) return { error: SILENT };
      timeout = args[i + 1];
      i += 2;
    } else if (arg.startsWith("--timeout=")) {
      timeout = arg.slice("--timeout=".length);
      i++;
    } else if (arg.startsWith("-")) {
      return { error: die(`tm compact: unknown flag: ${arg}`) };
    } else if (repo === "") {
      repo = arg;
      i++;
    } else {
      timeout = arg;
      i++;
    }
  }
  return { repo, timeout };
}
var COMPACT_REFUSAL_MARK = "\u23BF  Error: Not enough messages to compact";
var compact = async (args, _options, env) => {
  const parsed = parseCompactArgs(args);
  if ("error" in parsed) return parsed.error;
  const { repo, timeout } = parsed;
  if (repo === "") return die("usage: tm compact <repo> [timeout=1800] [--timeout N]");
  if (!isNonNegativeInteger(timeout)) {
    return die(`tm compact: --timeout must be a non-negative integer (got: '${timeout}')`);
  }
  const sessionMissing = await requireSession(repo, env.runTmux);
  if (sessionMissing !== null) return sessionMissing;
  const sidR = resolveSidOrDie(repo);
  if ("error" in sidR) return sidR.error;
  const sid = sidR.sid;
  const pane = await resolvePaneTarget(repo, env.runTmux);
  if (pane === "") return die(`could not resolve pane target for ${repo}`);
  let stderr = `tm compact: sending /compact to ${repo} (sid=${sid}, timeout=${timeout}s)
`;
  const sent = await sendKeys(repo, "/compact", env);
  stderr += sent.stderr;
  if (sent.code !== 0) {
    return { code: sent.code, stdout: sent.stdout, stderr };
  }
  const timeoutSec = Number(timeout);
  const end = nowSec() + timeoutSec;
  const marker = idleMarkerFor(sid);
  while (nowSec() < end) {
    if (existsSync(marker)) {
      return { code: 0, stdout: "compacted\n", stderr };
    }
    if (pane.length > 0) {
      try {
        const captured = await env.runTmux(["capture-pane", "-t", pane, "-p"]);
        if (captured.code === 0 && captured.stdout.includes(COMPACT_REFUSAL_MARK)) {
          return {
            code: 1,
            stdout: "",
            stderr: stderr + `tm compact: ${repo} refused /compact \u2014 Claude Code reported 'Not enough messages to compact' (transcript too short).
`
          };
        }
      } catch {
      }
    }
    await sleepMs(3e3);
  }
  return {
    code: 1,
    stdout: "",
    stderr: stderr + `tm compact: ${repo} did not signal PostCompact within ${timeout}s \u2014 compaction may still be running, or the Stop hook is misconfigured. Check 'tm status ${repo}' and ${marker}.
`
  };
};
function parseResumeArgs(args) {
  const SILENT = { code: 1, stdout: "", stderr: "" };
  let repo = "";
  let sid = "";
  let task = "";
  let prompt = "";
  let hasPrompt = false;
  let noWait = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--prompt") {
      if (i + 1 >= args.length) return { error: die("tm resume: --prompt requires a value") };
      prompt = args[i + 1];
      hasPrompt = true;
      i += 2;
    } else if (arg.startsWith("--prompt=")) {
      prompt = arg.slice("--prompt=".length);
      hasPrompt = true;
      i++;
    } else if (arg === "--task") {
      if (i + 1 >= args.length) return { error: SILENT };
      task = args[i + 1];
      i += 2;
    } else if (arg.startsWith("--task=")) {
      task = arg.slice("--task=".length);
      i++;
    } else if (arg === "--no-wait") {
      noWait = true;
      i++;
    } else if (arg === "--") {
      i++;
      break;
    } else if (arg.startsWith("-")) {
      return { error: die(`unknown flag: ${arg}`) };
    } else if (repo === "") {
      repo = arg;
      i++;
    } else if (sid === "") {
      sid = arg;
      i++;
    } else {
      return {
        error: die(
          `tm resume: too many positional args (got '${arg}' after repo='${repo}' sid='${sid}')`
        )
      };
    }
  }
  return { repo, sid, task, prompt, hasPrompt, noWait };
}
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var resume = async (args, _options, env) => {
  const parsed = parseResumeArgs(args);
  if ("error" in parsed) return parsed.error;
  let { sid } = parsed;
  const { repo, task, prompt, hasPrompt, noWait } = parsed;
  if (repo === "") {
    return die(
      'usage: tm resume <repo> [<sid>] [--task <slug>] [--prompt "..."] [--no-wait]  (sid from ledger preferred; auto-pick on omit; --task relabels the resumed conversation; --no-wait only with --prompt)'
    );
  }
  if (noWait && !hasPrompt) {
    return die("tm resume: --no-wait is only valid with --prompt");
  }
  const path = join2(env.dispatcherDir, repo);
  if (!isDirectory(path)) return dieRepoNotFound("resume", repo, path, env.dispatcherDir);
  const name = `${SESSION_PREFIX}${repo}`;
  if (await sessionExists(name, env.runTmux)) {
    return die(
      `${repo} already running (tmux=${name}) \u2014 'tm kill ${repo}' first if you really want to start over`
    );
  }
  const projectDir = projectDirForRepo(repo, env);
  let autoPickStderr = "";
  if (sid === "") {
    if (!isDirectory(projectDir)) {
      return die(
        `no project dir at ${projectDir} \u2014 has anyone ever run claude inside ${path}? Try 'tm spawn ${repo}' first.`
      );
    }
    let names = [];
    try {
      names = readdirSync(projectDir).filter((file) => file.endsWith(".jsonl"));
    } catch {
      names = [];
    }
    if (names.length === 0) {
      return die(`no .jsonl transcripts under ${projectDir} \u2014 try 'tm spawn ${repo}' to start fresh.`);
    }
    const stats = names.map((file) => {
      let mtime = 0;
      try {
        mtime = Math.floor(statSync(join2(projectDir, file)).mtimeMs / 1e3);
      } catch {
        mtime = 0;
      }
      return { file, mtime };
    });
    stats.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    const latest = stats[0];
    sid = latest.file.replace(/\.jsonl$/, "");
    autoPickStderr = `tm resume: no sid given \u2014 auto-picked ${sid} (jsonl mtime ${fmtLocalDateTime(latest.mtime)}). Prefer passing the sid from your task ledger.
`;
  } else {
    const target = join2(projectDir, `${sid}.jsonl`);
    if (!isRegularFile(target)) {
      return die(
        `no transcript at ${target} \u2014 wrong repo for this sid, or sid does not exist. Check 'ls ${projectDir}/'.`
      );
    }
  }
  if (!UUID_RE.test(sid)) return die(`sid is not a valid uuid: ${sid}`);
  const spawnArgs = [repo, "--resume", sid];
  if (task.length > 0) {
    spawnArgs.push("--task", task);
  }
  if (hasPrompt) {
    if (noWait) spawnArgs.push("--no-wait");
    spawnArgs.push("--prompt", prompt);
  }
  const result = await spawn2(spawnArgs, void 0, env);
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: autoPickStderr + result.stderr
  };
};
var NATIVE_VERBS = {
  ls,
  last,
  ctx,
  states,
  mem,
  history,
  status,
  poll,
  kill,
  archive,
  reload,
  doctor,
  spawn: spawn2,
  send,
  wait,
  compact,
  resume
};

// src/tmux.ts
function resolveTmuxBinary() {
  const override = process.env.CLAUDEMUX_TMUX;
  if (override && override.length > 0) return override;
  return "tmux";
}
var runTmux = (args, options) => spawnCapture([resolveTmuxBinary(), ...args], options);

// src/cli.ts
import { homedir } from "node:os";
import { join as join3 } from "node:path";
function triggersHelp(args) {
  for (const arg of args) {
    if (arg === "-h" || arg === "--help") return true;
    if (arg === "--prompt" || arg.startsWith("--prompt=")) return false;
    if (!arg.startsWith("-")) return false;
  }
  return false;
}
function removedVerb(message) {
  return { code: 2, stdout: "", stderr: message };
}
function unknownVerb(verb) {
  return {
    code: 1,
    stdout: OVERVIEW_HELP,
    stderr: `tm: unknown subcommand: ${verb}
`
  };
}
function runHelpVerb(rest) {
  const target = rest[0];
  if (target === void 0) return { code: 0, stdout: OVERVIEW_HELP, stderr: "" };
  if (target === "help" || target === "-h" || target === "--help") {
    return { code: 0, stdout: OVERVIEW_HELP, stderr: "" };
  }
  if (Object.hasOwn(HELP_TEXTS, target)) {
    return { code: 0, stdout: HELP_TEXTS[target], stderr: "" };
  }
  return {
    code: 1,
    stdout: OVERVIEW_HELP,
    stderr: `tm: no help for unknown verb: ${target}
`
  };
}
async function runCli(argv, env, stdin) {
  const [verb, ...rest] = argv;
  if (verb === void 0 || verb === "") {
    return { code: 0, stdout: OVERVIEW_HELP, stderr: "" };
  }
  if (verb === "help" || verb === "-h" || verb === "--help") {
    return runHelpVerb(rest);
  }
  if (triggersHelp(rest)) {
    const text = Object.hasOwn(HELP_TEXTS, verb) ? HELP_TEXTS[verb] : OVERVIEW_HELP;
    return { code: 0, stdout: text, stderr: "" };
  }
  if (Object.hasOwn(REMOVED_VERB_MESSAGES, verb)) {
    return removedVerb(REMOVED_VERB_MESSAGES[verb]);
  }
  if (Object.hasOwn(NATIVE_VERBS, verb)) {
    const handler = NATIVE_VERBS[verb];
    const options = stdin != null ? { stdin } : void 0;
    return handler(rest, options, env);
  }
  return unknownVerb(verb);
}
function productionEnv() {
  return {
    runTmux,
    runColumn,
    runGrep,
    // `tm` resolves the dispatcher dir from `TM_DISPATCHER_DIR` or `$PWD`
    // (bash's `${TM_DISPATCHER_DIR:-$PWD}`). Two semantics matter here:
    //   - `$PWD` is the *logical* cwd, preserving the symlink the user
    //     `cd`'d through; Node's `process.cwd()` would return the
    //     symlink-resolved physical path, and `~/.claude/projects` lookups
    //     would diverge between bash and native on a symlinked dispatcher
    //     tree.
    //   - bash `${VAR:-default}` triggers the default on *unset* OR *empty*,
    //     so `||` (which treats empty strings as falsy) is the right
    //     operator — `??` would let an accidentally-empty
    //     `TM_DISPATCHER_DIR` through and resolve `<repo>` paths against
    //     `""`, while `tm doctor`'s own check treats empty as unset and
    //     reports the opposite of what the verbs saw.
    dispatcherDir: process.env.TM_DISPATCHER_DIR || process.env.PWD || process.cwd(),
    projectsDir: join3(process.env.HOME ?? homedir(), ".claude", "projects")
  };
}

// src/main.ts
async function readStdin() {
  if (process.stdin.isTTY) return void 0;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}
async function main() {
  const argv = process.argv.slice(2);
  const needsStdin = argv[0] === "archive" && !triggersHelp(argv.slice(1));
  const stdin = needsStdin ? await readStdin() : void 0;
  const result = await runCli(argv, productionEnv(), stdin);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
main().catch((err) => {
  process.stderr.write(`[tm] ${err instanceof Error ? err.message : String(err)}
`);
  process.exitCode = 1;
});
