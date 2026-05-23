/**
 * Native verb implementations — Phase B of the strangler migration.
 *
 * Phase A fronted every `tm` verb with a shell-out (`tm.ts`). Phase B replaces
 * those shell-outs with native TypeScript, one verb at a time, read-only verbs
 * first (`.agents/domains/mcp-native-orchestrator.md` §12). A migrated verb is
 * a `NativeVerb` in this module; `core.ts` runs it instead of shelling out.
 *
 * A `NativeVerb` returns a `TmResult` — the exact `{code, stdout, stderr}`
 * shape `runTm` returns — not a `CallToolResult`. That keeps `verbResult` (in
 * `core.ts`) the single result-shaping site, and it makes the migration's
 * correctness criterion literal: a native verb conforms iff its `TmResult`
 * equals what `tm <verb>` produces for the same inputs. `test/conformance.test.ts`
 * is that differential check, against the live `tm`.
 *
 * Migration is behavior-preserving: a native verb reproduces what `tm` does
 * today, bug for bug, down to the exact text of an error line. Fixing a `tm`
 * behavior is a separate change, never folded into the migration.
 *
 * Migrated so far: `ls`, `last`, `ctx`, `states`, `mem`, `history`, `status`,
 * `poll`, `kill`, `archive`, `reload`.
 *
 * `reload` is the one native verb that itself shells out to `tm`: it is sugar
 * over `tm send --no-wait`, and `send` is not yet migrated, so `reload` fans
 * out natively but delegates each teammate's send to a `tm send` subprocess.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  busyMarkerFor,
  cwdFile,
  encodeProjectDir,
  idleDir,
  idleMarkerFor,
  lastFileFor,
  readyFile,
  sendAtFile,
  sidFile,
} from './paths'
import type { TmResult, TmRunOptions, TmRunner } from './tm'
import type { ColumnRunner } from './column'
import type { GrepRunner } from './grep'
import type { TmuxRunner } from './tmux'

/** The teammate session-name prefix — `tm`'s `PREFIX`, mirrored here. */
const SESSION_PREFIX = 'teammate-'

/** Everything a native verb may need beyond its arguments; injectable for tests. */
export interface NativeEnv {
  /** Runs `tmux` — injected so a conformance fixture can supply a fake. */
  runTmux: TmuxRunner
  /** Aligns tab-separated rows via `column -t` — for table-rendering verbs. */
  runColumn: ColumnRunner
  /** Matches input against a regex via `grep -qE` — for the `poll` verb. */
  runGrep: GrepRunner
  /** Shells out to `tm` — for `reload`, which fans out over `tm send`. */
  runTm: TmRunner
  /** The dispatcher directory — the parent of the sibling teammate repos. */
  dispatcherDir: string
  /** The `~/.claude/projects` directory that holds Claude Code transcripts. */
  projectsDir: string
}

/**
 * One natively-migrated verb. Same call shape as a `tm` shell-out and the
 * same `TmResult` return, so `core.ts` can swap one for the other and shape
 * the result identically.
 */
export type NativeVerb = (
  args: readonly string[],
  options: TmRunOptions | undefined,
  env: NativeEnv,
) => Promise<TmResult>

/**
 * `tm`'s `die`: one `tm: <message>` line on stderr, exit 1. Native error
 * paths reproduce it verbatim so a conformance check is byte-exact.
 */
function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

/**
 * Whether `tm`'s `main` help pre-scan would intercept these verb arguments
 * and print per-verb help instead of dispatching to the verb. `main` scans
 * left to right: a `-h`/`--help` triggers help; a `--prompt` value or the
 * first non-flag positional stops the scan (help text must not swallow
 * prompt data that happens to contain `--help`).
 *
 * `core.ts` consults this so a `--help` invocation behaves as it did under
 * the Phase A shell-out — `tm` prints the help text — rather than reaching a
 * native handler, which has no help text of its own.
 */
export function triggersTmHelp(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') return true
    if (arg === '--prompt' || arg.startsWith('--prompt=')) return false
    if (!arg.startsWith('-')) return false
  }
  return false
}

/**
 * The session field of one `tmux ls` line — the text before the first `:`,
 * or the whole line when there is no `:`. This mirrors `awk -F:` `$1`, which
 * `tm ls` uses to pick out teammate sessions.
 */
function sessionField(line: string): string {
  const colon = line.indexOf(':')
  return colon >= 0 ? line.slice(0, colon) : line
}

/**
 * `tm ls` — list running teammate tmux sessions.
 *
 * Runs `tmux ls` and keeps the lines whose session name starts with
 * `teammate-`. `tmux ls` exits non-zero when no server is running; `tm`
 * masks that (`tmux ls || true`) and so does this — only stdout is read, and
 * an empty result is the ordinary "no sessions" case, not an error.
 */
const ls: NativeVerb = async (_args, _options, env) => {
  // `tm ls` masks every `tmux` failure (`tmux ls 2>/dev/null || true`): a
  // non-zero exit — and a `tmux` that cannot be spawned at all — is just the
  // ordinary "no sessions" case. So only stdout is read, and a runner that
  // throws (missing binary) is caught and treated as empty output.
  let listing = ''
  try {
    listing = (await env.runTmux(['ls'])).stdout
  } catch {
    listing = ''
  }
  const rows = listing
    .split('\n')
    .filter((line) => sessionField(line).startsWith(SESSION_PREFIX))
  const text =
    rows.length > 0
      ? `${rows.join('\n')}\n`
      : "(no teammate sessions; use 'tm spawn <repo>')\n"
  return { code: 0, stdout: text, stderr: '' }
}

/**
 * Read the recorded sid for a repo — `tm`'s `resolve_sid`. The `.sid` file
 * must exist and be non-empty (`-s`); its content is the sid with trailing
 * newlines stripped (the effect of bash `$(cat ...)`). Returns `null` when
 * there is no usable sid file.
 */
function resolveSid(repo: string): string | null {
  try {
    const file = sidFile(repo)
    if (statSync(file).size === 0) return null
    return readFileSync(file, 'utf8').replace(/\n+$/, '')
  } catch {
    return null
  }
}

/**
 * Read a file only if it exists and is non-empty — `tm`'s `[[ -s file ]]`
 * test. The size check is on bytes, like `-s`, so a file holding only
 * whitespace still counts as present. Returns the raw content, or `null`.
 */
function readIfNonEmpty(file: string): string | null {
  try {
    if (statSync(file).size === 0) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * `tm last` — reprint a teammate's last-turn reply.
 *
 * Resolves the repo's sid, then prints the `<sid>.last` marker verbatim. Two
 * empty states are both "no reply yet": the file missing, or the file present
 * but zero bytes (a fresh-spawn sentinel, or a turn that extracted no text).
 */
const last: NativeVerb = async (args) => {
  const repo = args[0] ?? ''
  if (repo.length === 0) return die('usage: tm last <repo>')

  const sid = resolveSid(repo)
  if (sid === null) {
    return die(
      `no sid file for ${repo} at ${sidFile(repo)} — was this teammate ` +
        "spawned via 'tm spawn'? (raw 'tmux new-session' won't seed the sid)",
    )
  }

  const file = lastFileFor(sid)
  const reply = readIfNonEmpty(file)
  if (reply === null) {
    return die(
      `no reply yet for ${repo} (sid=${sid}) — file is missing or empty at ` +
        `${file}. Try 'tm wait ${repo}' to block for the next Stop, or ` +
        `'tm send ${repo} --prompt "..."' to drive a turn.`,
    )
  }
  return { code: 0, stdout: reply, stderr: '' }
}

/** A teammate's context-window usage, summed from its transcript. */
interface CtxUsage {
  /** Tokens in the last assistant turn — input plus both cache reads. */
  used: number
  /** Output tokens of the last assistant turn. */
  out: number
  /** The largest `used`-style total across every assistant turn. */
  peak: number
}

/** Sum the cache-inclusive input tokens of one `message.usage` object. */
function usageInput(usage: Record<string, unknown>): number {
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
  return (
    num(usage.input_tokens) +
    num(usage.cache_creation_input_tokens) +
    num(usage.cache_read_input_tokens)
  )
}

/** Whether a value is a plain JSON object — not a primitive, not an array. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a teammate's ctx usage from its transcript jsonl — the native form of
 * the `jq -s` pass in `tm`'s `_ctx_format_line`. It collects the
 * `message.usage` of every assistant entry: `used`/`out` come from the last
 * one, `peak` is the max input across all. Returns `null` when there is no
 * usable usage — which includes the cases where `jq -s` fails:
 *
 * `jq -s` slurps the *whole* file, then its filter indexes `.type` on every
 * entry and `.message.usage` on the assistant ones. A line `jq` cannot index
 * — a non-object (a bare number/string/array), or an assistant entry whose
 * `.message`/`.message.usage` is a non-object — errors the entire pass, which
 * `tm` reports as the `?` diagnostic. So such a line *fails the file* here
 * too; it is not silently skipped. (`jq` does tolerate a bare `null` line and
 * a missing/`null` `.message`/`.usage` — those drop out without an error.)
 */
function readCtxUsage(jsonl: string): CtxUsage | null {
  let content: string
  try {
    content = readFileSync(jsonl, 'utf8')
  } catch {
    return null
  }
  const inputs: number[] = []
  let lastOut = 0
  for (const line of content.split('\n')) {
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      return null
    }
    if (entry === null) continue
    if (!isPlainObject(entry)) return null
    if (entry.type !== 'assistant') continue
    const message = entry.message
    if (message === null || message === undefined) continue
    if (!isPlainObject(message)) return null
    const usage = message.usage
    if (usage === null || usage === undefined) continue
    if (!isPlainObject(usage)) return null
    inputs.push(usageInput(usage))
    lastOut = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
  }
  if (inputs.length === 0) return null
  // A plain reduce, not `Math.max(...inputs)` — a long transcript can hold
  // more entries than the argument-spread limit, and `jq`'s `max` has none.
  let peak = inputs[0]!
  for (const value of inputs) if (value > peak) peak = value
  return { used: inputs[inputs.length - 1]!, out: lastOut, peak }
}

/** The Claude Code transcript file for a teammate session under `projectsDir`. */
function transcriptFile(projectsDir: string, cwd: string, sid: string): string {
  return join(projectsDir, encodeProjectDir(cwd), `${sid}.jsonl`)
}

/** Whether a path exists and is a regular file — `tm`'s `[[ -f ]]` test. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Whether a path exists and is a directory — `tm`'s `[[ -d ]]` test. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * One teammate's `ctx` line. Soft-fails to a `? (...)` diagnostic line — like
 * `tm`'s `ctx_one` — so `ctx --all` keeps going across teammates with no
 * readable transcript. `windowOverride` is `''`, `'200k'`, or `'1m'`.
 */
function ctxLine(repo: string, windowOverride: string, env: NativeEnv): string {
  const sid = resolveSid(repo)
  if (sid === null) return `${repo}: ? (no sid file)`

  // The teammate's cwd: its recorded `.cwd` file, else `<dispatcher>/<repo>`.
  const recordedCwd = readIfNonEmpty(cwdFile(repo))
  const cwd =
    recordedCwd !== null ? recordedCwd.replace(/\n+$/, '') : `${env.dispatcherDir}/${repo}`
  const jsonl = transcriptFile(env.projectsDir, cwd, sid)
  if (!isRegularFile(jsonl)) return `${repo}: ? (no transcript at ${jsonl})`

  const usage = readCtxUsage(jsonl)
  if (usage === null) return `${repo}: ? (no assistant usage in transcript)`

  const next = usage.used + usage.out
  let window: number
  let note: string
  if (windowOverride === '1m') {
    window = 1000000
    note = 'flag'
  } else if (windowOverride === '200k') {
    window = 200000
    note = 'flag'
  } else if (usage.peak > 210000) {
    // A peak above ~210k can only have happened on a 1M-token window.
    window = 1000000
    note = 'detected 1M'
  } else {
    window = 200000
    note = 'assumed 200k'
  }
  const pct = Math.floor((usage.used * 100) / window)
  const wlabel = window >= 1000000 ? '1M' : '200k'
  return `${repo}: ${usage.used} tokens · ~${next} next turn · ${pct}% of ${wlabel} (${note})`
}

/** The running teammate repo names, from `tmux ls` — `tm`'s `iter_repos`. */
async function iterRepos(runTmux: TmuxRunner): Promise<string[]> {
  let listing = ''
  try {
    listing = (await runTmux(['ls'])).stdout
  } catch {
    listing = ''
  }
  const repos: string[] = []
  for (const line of listing.split('\n')) {
    const field = sessionField(line)
    if (field.startsWith(SESSION_PREFIX)) repos.push(field.slice(SESSION_PREFIX.length))
  }
  return repos
}

/** The outcome of parsing `ctx`'s arguments: a plan, or an early-exit result. */
type CtxArgs = { repos: string[]; windowOverride: string; all: boolean } | { error: TmResult }

/**
 * Parse `tm ctx`'s flags — `--all`, `--window <v>`, `--window=<v>` — mirroring
 * `cmd_ctx`'s loop. A bare `--window` with no value reproduces `tm`'s quirk: a
 * `shift 2` past the end of the arguments fails under `set -e`, so `tm` exits
 * 1 with no output at all.
 */
function parseCtxArgs(args: readonly string[]): CtxArgs {
  const repos: string[] = []
  let windowOverride = ''
  let all = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--all') {
      all = true
    } else if (arg === '--window') {
      if (i + 1 >= args.length) return { error: { code: 1, stdout: '', stderr: '' } }
      windowOverride = args[i + 1]!
      i++
    } else if (arg.startsWith('--window=')) {
      windowOverride = arg.slice('--window='.length)
    } else if (arg.startsWith('-')) {
      return { error: die(`tm ctx: unknown flag: ${arg}`) }
    } else {
      repos.push(arg)
    }
  }
  if (windowOverride !== '' && windowOverride !== '200k' && windowOverride !== '1m') {
    return { error: die('tm ctx: --window must be 200k or 1m') }
  }
  return { repos, windowOverride, all }
}

/**
 * `tm ctx` — report context-window usage for one or more teammates.
 *
 * Each teammate yields one line, or a `? (...)` diagnostic when its transcript
 * cannot be read; `--all` fans out across every running teammate. Migrating
 * the verb keeps the jsonl parse in the core rather than shelling out to `jq`.
 */
const ctx: NativeVerb = async (args, _options, env) => {
  const parsed = parseCtxArgs(args)
  if ('error' in parsed) return parsed.error

  const repos = [...parsed.repos]
  if (parsed.all) repos.push(...(await iterRepos(env.runTmux)))
  if (repos.length === 0) {
    return die('usage: tm ctx <repo> [<repo>...] | --all  [--window 200k|1m]')
  }

  const lines = repos.map((repo) => ctxLine(repo, parsed.windowOverride, env))
  return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
}

/** Format a second-count as a short relative age — `tm`'s `fmt_age`. */
function fmtAge(age: number): string {
  if (age < 60) return `${age}s`
  if (age < 3600) return `${Math.floor(age / 60)}m`
  if (age < 86400) return `${Math.floor(age / 3600)}h`
  return `${Math.floor(age / 86400)}d`
}

/**
 * The `PREVIEW` cell for one teammate — the first line of its `.last`, with
 * control characters stripped, truncated to 50 characters (code points, as
 * `tm`'s `perl -CSD substr` counts them). Empty after stripping, or the file
 * unreadable, → `(no first line)`.
 */
function lastPreview(lastFile: string): string {
  let content: string
  try {
    content = readFileSync(lastFile, 'utf8')
  } catch {
    return '(no first line)'
  }
  // Strip control characters (code point <= 0x1f), then take the first 50
  // characters — `tr -d` then `perl -CSD substr` in `tm`. Iterate code
  // points so the count matches perl's `-CSD` character count.
  const preview = [...(content.split('\n')[0] ?? '')]
    .filter((ch) => (ch.codePointAt(0) ?? 0) > 0x1f)
    .slice(0, 50)
    .join('')
  return preview.length > 0 ? preview : '(no first line)'
}

/** One `states` table row for a teammate: REPO, SID, BUSY, LAST, PREVIEW. */
function statesRow(repo: string, now: number): string[] {
  const sid = resolveSid(repo)
  const sidShort = sid === null ? '?' : sid.slice(0, 8)
  // `pane_busy`: a teammate is busy iff its `.busy` marker file exists.
  const busy = sid !== null && isRegularFile(busyMarkerFor(sid)) ? 'yes' : 'no'
  let last = '-'
  let preview = '-'
  if (sid !== null && sid.length > 0) {
    const lf = lastFileFor(sid)
    let stat: Stats | null
    try {
      stat = statSync(lf)
    } catch {
      stat = null
    }
    // `[[ -s "$lf" ]]` — present and non-empty.
    if (stat !== null && stat.size > 0) {
      const age = now - Math.floor(stat.mtimeMs / 1000)
      last = `${stat.size}B/${fmtAge(age)}`
      preview = lastPreview(lf)
    }
  }
  return [repo, sidShort, busy, last, preview]
}

/**
 * `tm states` — a one-line fleet snapshot of every teammate: its sid, whether
 * it is mid-turn, and the size / age / preview of its last reply.
 *
 * The per-teammate row logic is native; the table is aligned by piping the
 * tab-separated rows through `column -t`, exactly as `cmd_states` does.
 */
const states: NativeVerb = async (_args, _options, env) => {
  const repos = await iterRepos(env.runTmux)
  if (repos.length === 0) return { code: 0, stdout: '(no teammate sessions)\n', stderr: '' }

  // `now` is sampled once, before the loop — `tm`'s `cmd_states` does the same.
  const now = Math.floor(Date.now() / 1000)
  const rows = [
    ['REPO', 'SID', 'BUSY', 'LAST', 'PREVIEW'],
    ...repos.map((repo) => statesRow(repo, now)),
  ]
  // The `column` result *is* the verb's result — `tm`'s `cmd_states` likewise
  // ends in `| column`, so `column`'s exit code, stdout, and stderr are what
  // `tm states` produces.
  return env.runColumn(`${rows.map((row) => row.join('\t')).join('\n')}\n`)
}

/**
 * `tm`'s `die_repo_not_found` — the shared "`<repo>` is not under the
 * dispatcher dir" failure for the repo-keyed verbs. When the dispatcher dir is
 * itself a git working tree, `tm` assumes the user pointed at a single repo
 * instead of the parent of sibling repos and steers them to `cd` up;
 * otherwise it prints the generic "repo not found" line. Both are a `die`.
 */
function dieRepoNotFound(
  verb: string,
  repo: string,
  path: string,
  dispatcherDir: string,
): TmResult {
  if (isDirectory(join(dispatcherDir, '.git'))) {
    return die(
      `${dispatcherDir} looks like a git working tree (.git exists), not a dispatcher root.\n` +
        '    The dispatcher dir should be the PARENT of your sibling repos.\n' +
        `    Try:  cd "${dirname(dispatcherDir)}" && tm ${verb} ${repo}\n` +
        "    (Or set TM_DISPATCHER_DIR in your dispatcher's .claude/settings.json\n" +
        '    — run /claudemux:setup to wire it up automatically.)',
    )
  }
  return die(
    `repo not found at ${path} — <repo> must be a direct subdirectory of the ` +
      `dispatcher dir (${dispatcherDir}). Dispatcher dir is read from ` +
      "TM_DISPATCHER_DIR (env) or $PWD; if it's wrong, set TM_DISPATCHER_DIR or " +
      'run tm from the right place.',
  )
}

/**
 * The Claude Code project directory for a teammate repo — `tm`'s
 * `project_dir_for_repo`. The repo's *physical* path (symlinks resolved, as
 * `cd && pwd -P` does) is encoded, so a symlinked dispatcher tree still
 * addresses the directory Claude Code actually wrote on disk. The caller must
 * have already confirmed `<dispatcherDir>/<repo>` exists — `realpathSync`
 * needs a real path — which `tm`'s callers likewise check up front.
 */
function projectDirForRepo(repo: string, env: NativeEnv): string {
  const phys = realpathSync(join(env.dispatcherDir, repo))
  return join(env.projectsDir, encodeProjectDir(phys))
}

/**
 * `tm mem` — print a sibling repo's auto-memory index.
 *
 * Reads the repo's `~/.claude/projects/<dir>/memory/MEMORY.md`. A repo that
 * never ran Claude Code — or whose project dir was pruned — has no such file;
 * that is a normal "no sibling memory" case, reported on stderr with exit 0
 * (not an error) so a dispatcher composing a spawn prompt can call `mem`
 * opportunistically. An empty `MEMORY.md` is still a file, so it prints as
 * empty output with exit 0 — `tm`'s `[[ -f ]]` then `cat`, reproduced.
 */
const mem: NativeVerb = async (args, _options, env) => {
  const repo = args[0] ?? ''
  if (repo.length === 0) return die('usage: tm mem <repo>')

  const path = join(env.dispatcherDir, repo)
  if (!isDirectory(path)) return dieRepoNotFound('mem', repo, path, env.dispatcherDir)

  const mfile = join(projectDirForRepo(repo, env), 'memory', 'MEMORY.md')
  if (!isRegularFile(mfile)) {
    return {
      code: 0,
      stdout: '',
      stderr: `tm mem: no auto-memory recorded for ${repo} (looked at ${mfile})\n`,
    }
  }
  return { code: 0, stdout: readFileSync(mfile, 'utf8'), stderr: '' }
}

/**
 * One-decimal string of `value`, rounding a `.x5` tie to even — C `printf`'s
 * `%.1f`, which `fmt_size`'s `awk` uses. `Number.toFixed` rounds half away
 * from zero, so it would print `1.3M` where `awk` prints `1.2M` for a file of
 * exactly 1.25 MiB; this keeps the size cells byte-identical to `tm`.
 */
function toFixed1HalfEven(value: number): string {
  const tenths = value * 10
  const floor = Math.floor(tenths)
  const frac = tenths - floor
  let rounded: number
  if (frac < 0.5) rounded = floor
  else if (frac > 0.5) rounded = floor + 1
  else rounded = floor % 2 === 0 ? floor : floor + 1
  return (rounded / 10).toFixed(1)
}

/** Format a byte count as a short human size — `tm`'s `fmt_size`. */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${Math.trunc(bytes / 1024)}K`
  if (bytes < 1073741824) return `${toFixed1HalfEven(bytes / 1048576)}M`
  return `${toFixed1HalfEven(bytes / 1073741824)}G`
}

/**
 * Format an epoch-seconds value as `YYYY-MM-DD HH:MM:SS` in local time — the
 * `tm` `history_detail` `last_seen` field. `tm` does this with BSD `date -r`,
 * so this rendering matches `tm` on macOS; `date -r <epoch>` is not portable
 * to GNU, which is why `history`'s detail-mode conformance is macOS-gated.
 */
function fmtLocalDateTime(epochSec: number): string {
  const d = new Date(epochSec * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/** `tm`'s `sed -E 's/T/ /; s/\.[0-9]+Z?$//; s/Z$//'` on a transcript timestamp. */
function mungeCreated(ts: string): string {
  return ts.replace('T', ' ').replace(/\.[0-9]+Z?$/, '').replace(/Z$/, '')
}

/** Prefix every line of `text` with two spaces — `tm`'s `sed 's/^/  /'`. */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

/** A bare-integer string's numeric value, as bash arithmetic reads it (`null` → 0). */
function bashNum(value: string): number {
  const n = Number(value)
  return Number.isInteger(n) ? n : 0
}

/**
 * The `text`-typed items of a transcript entry's `content` array. Returns the
 * list of their `.text` values when the array has at least one text item, or
 * `null` when it has none (not a selectable entry). Throws on a shape `jq`
 * errors on — a non-object array item, or a non-string non-null `.text`.
 */
function contentTextItems(content: readonly unknown[]): string[] | null {
  let hasText = false
  const texts: string[] = []
  for (const item of content) {
    if (!isPlainObject(item)) throw new Error('jq-fail')
    if (item.type === 'text') {
      hasText = true
      const t = item.text
      if (t === null || t === undefined) texts.push('')
      else if (typeof t === 'string') texts.push(t)
      else throw new Error('jq-fail')
    }
  }
  return hasText ? texts : null
}

/**
 * The prompt text of a `user` transcript entry — `tm`'s shared filter: a
 * string `content` is the text itself; an array `content` joins its `text`
 * items with a space. Returns `null` when the entry is not a selectable user
 * prompt. Throws on a shape `jq` errors on (a non-object `.message`, or a
 * non-object content-array item).
 */
function userPromptText(entry: Record<string, unknown>): string | null {
  const message = entry.message
  if (message === null || message === undefined) return null
  if (!isPlainObject(message)) throw new Error('jq-fail')
  if (message.role !== 'user') return null
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts = contentTextItems(content)
    return texts === null ? null : texts.join(' ')
  }
  return null
}

/** A `message.usage` object's cache-inclusive input total — `null` when every field is absent. */
function historyUsageSum(usage: unknown): number | null {
  if (!isPlainObject(usage)) throw new Error('jq-fail')
  let sum: number | null = null
  for (const key of [
    'input_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ] as const) {
    const value = usage[key]
    if (value === null || value === undefined) continue
    if (typeof value !== 'number') throw new Error('jq-fail')
    sum = (sum ?? 0) + value
  }
  return sum
}

/** `jq`'s `tostring` on a usage sum: a number, or the literal `null`. */
function historyUsageStr(sum: number | null): string {
  return sum === null ? 'null' : String(sum)
}

/** First-line-of-first-user-prompt — `tm`'s `history_first_prompt` (`jq` without `-s`). */
function historyFirstPrompt(content: string): string {
  // `head -200`: a human first prompt sits near the file head, so the scan is
  // capped there. `jq` without `-s` reports a bad line and moves on, so a
  // parse error or a filter error skips that line rather than failing.
  for (const line of content.split('\n').slice(0, 200)) {
    if (line.trim() === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isPlainObject(entry) || entry.type !== 'user') continue
    let text: string | null
    try {
      text = userPromptText(entry)
    } catch {
      continue
    }
    if (text === null) continue
    // `jq -r` prints the value, `head -1` keeps its first line.
    return text.split('\n')[0] ?? ''
  }
  return ''
}

/** The `TOPIC` cell for a `history` row — first prompt, control chars stripped, 60 chars. */
function historyTopic(content: string): string {
  // `tr -d '\000-\037'` then `perl -CSD substr 0,60` — strip control code
  // points, then take the first 60 by code point, as `tm` counts them.
  const stripped = [...historyFirstPrompt(content)].filter(
    (ch) => (ch.codePointAt(0) ?? 0) > 0x1f,
  )
  const topic = stripped.slice(0, 60).join('')
  return topic.length > 0 ? topic : '(no user prompt)'
}

/** The five fields `history_detail`'s `jq -s` pass yields, after base64 decode. */
interface HistoryData {
  /** `$u_prompts[0]` — the first user prompt, trailing newlines stripped. */
  firstPrompt: string
  /** `$a_texts[-1]` — the last assistant text, trailing newlines stripped. */
  lastAssistant: string
  /** `$ts[0]` — the first entry timestamp. */
  createdTs: string
  /** The last assistant turn's cache-inclusive input total — `tostring`'d. */
  used: string
  /** The largest such total across the transcript — `tostring`'d. */
  peak: string
}

/** The all-empty `HistoryData` — `tm`'s `jq` failure sentinel (`echo $'\t\t\t\t\t'`). */
const EMPTY_HISTORY: HistoryData = {
  firstPrompt: '',
  lastAssistant: '',
  createdTs: '',
  used: '',
  peak: '',
}

/**
 * Read a transcript's `history_detail` data — the native form of `tm`'s
 * `jq -r -s` pass. `jq -s` slurps the whole file: one unparseable line, or any
 * line `jq` errors while indexing, fails the entire pass — `tm` catches that
 * with `|| echo $'\t\t\t\t\t'`, six empty fields. So any such failure here
 * returns `EMPTY_HISTORY`, which renders identically to a transcript that
 * simply has no prompts, assistant text, or usage.
 *
 * One `tm` quirk is deliberately not reproduced. `tm` joins the six fields
 * with tabs and re-splits them with `IFS=$'\t' read`; tab is IFS whitespace,
 * so an empty field mid-row collapses and shifts every field after it. That
 * is unreachable on a real Claude Code transcript — every entry carries a
 * `.timestamp`, so the timestamp field is never empty — and a clean native
 * parse is a strict improvement, the same call as the `date -r` handling.
 */
function readHistoryData(content: string): HistoryData {
  try {
    const uPrompts: string[] = []
    const aTexts: string[] = []
    const usages: unknown[] = []
    const timestamps: unknown[] = []
    for (const line of content.split('\n')) {
      if (line.trim() === '') continue
      const entry: unknown = JSON.parse(line)
      if (entry === null) continue
      if (!isPlainObject(entry)) throw new Error('jq-fail')
      if (entry.type === 'user') {
        const text = userPromptText(entry)
        if (text !== null) uPrompts.push(text)
      } else if (entry.type === 'assistant') {
        const message = entry.message
        if (message !== null && message !== undefined) {
          if (!isPlainObject(message)) throw new Error('jq-fail')
          if (Array.isArray(message.content)) {
            const texts = contentTextItems(message.content)
            if (texts !== null) aTexts.push(texts.join('\n'))
          }
          if (message.usage !== null && message.usage !== undefined) {
            usages.push(message.usage)
          }
        }
      }
      const ts = entry.timestamp
      if (ts !== null && ts !== undefined) timestamps.push(ts)
    }

    let createdTs = ''
    if (timestamps.length > 0) {
      const first = timestamps[0]
      if (first === false) createdTs = ''
      else if (typeof first === 'string') createdTs = first
      else throw new Error('jq-fail') // jq: a non-string timestamp + "\t" errors
    }

    let used = ''
    let peak = ''
    if (usages.length > 0) {
      const sums = usages.map(historyUsageSum)
      used = historyUsageStr(sums[sums.length - 1] ?? null)
      let peakNum: number | null = null
      for (const sum of sums) {
        if (sum !== null && (peakNum === null || sum > peakNum)) peakNum = sum
      }
      peak = historyUsageStr(peakNum)
    }

    return {
      firstPrompt: (uPrompts[0] ?? '').replace(/\n+$/, ''),
      lastAssistant: (aTexts[aTexts.length - 1] ?? '').replace(/\n+$/, ''),
      createdTs,
      used,
      peak,
    }
  } catch {
    return EMPTY_HISTORY
  }
}

/**
 * `tm history <repo>` — list a teammate repo's past Claude Code sessions, one
 * per transcript jsonl, newest first. The rows are built natively and aligned
 * by the real `column -t`, exactly as `tm`'s `history_list` does.
 */
async function historyList(repo: string, projectDir: string, env: NativeEnv): Promise<TmResult> {
  if (!isDirectory(projectDir)) {
    return { code: 0, stdout: `(no past sessions for ${repo})\n`, stderr: '' }
  }
  let names: string[]
  try {
    names = readdirSync(projectDir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    names = []
  }
  if (names.length === 0) {
    return { code: 0, stdout: `(no past sessions for ${repo})\n`, stderr: '' }
  }

  const files = names.map((name) => {
    let mtime = 0
    try {
      mtime = Math.floor(statSync(join(projectDir, name)).mtimeMs / 1000)
    } catch {
      mtime = 0
    }
    return { name, mtime }
  })
  // `ls -t` — newest first; equal mtimes break by name (a `<`/`>` compare,
  // not `localeCompare`, so the tie order is the same on every CI runner).
  files.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const liveSid = resolveSid(repo) ?? ''
  const now = Math.floor(Date.now() / 1000)
  const rows: string[][] = [[' ', 'SID', 'AGE', 'SIZE', 'TOPIC']]
  for (const { name, mtime } of files) {
    const full = join(projectDir, name)
    const sidFull = name.replace(/\.jsonl$/, '')
    let size = 0
    try {
      size = statSync(full).size
    } catch {
      size = 0
    }
    let content = ''
    try {
      content = readFileSync(full, 'utf8')
    } catch {
      content = ''
    }
    const mark = liveSid !== '' && sidFull === liveSid ? '*' : ' '
    rows.push([
      mark,
      sidFull.slice(0, 8),
      fmtAge(now - mtime),
      fmtSize(size),
      historyTopic(content),
    ])
  }
  return env.runColumn(`${rows.map((row) => row.join('\t')).join('\n')}\n`)
}

/**
 * `tm history <repo> <sid-or-prefix>` — the detail view of one past session.
 * Resolves the prefix to a unique transcript, then prints `tm`'s
 * `history_detail` block: identity, size, timestamps, ctx usage, and the
 * first prompt / last assistant text (the latter truncated past 1500 chars).
 */
function historyDetail(repo: string, projectDir: string, prefix: string): TmResult {
  if (!/^[0-9a-f-]{1,36}$/.test(prefix)) {
    return die(
      `tm history: invalid sid prefix '${prefix}' — must match ^[0-9a-f-]{1,36}$`,
    )
  }
  if (!isDirectory(projectDir)) {
    return die(`tm history: no project dir at ${projectDir} for ${repo} (no sessions yet)`)
  }

  let names: string[]
  try {
    names = readdirSync(projectDir).filter(
      (name) =>
        name.startsWith(prefix) &&
        name.endsWith('.jsonl') &&
        isRegularFile(join(projectDir, name)),
    )
  } catch {
    names = []
  }
  names.sort()
  if (names.length === 0) {
    return die(`tm history: no session matching '${prefix}' in ${repo}`)
  }
  if (names.length > 1) {
    const cands = `${names.map((name) => name.replace(/\.jsonl$/, '')).join(' ')} `
    return die(
      `tm history: prefix '${prefix}' matches ${names.length} sessions — ` +
        `be more specific: ${cands}`,
    )
  }

  const name = names[0]!
  const file = join(projectDir, name)
  const sidFull = name.replace(/\.jsonl$/, '')
  let size = 0
  let mtime = 0
  try {
    const stat = statSync(file)
    size = stat.size
    mtime = Math.floor(stat.mtimeMs / 1000)
  } catch {
    size = 0
    mtime = 0
  }
  let content = ''
  try {
    content = readFileSync(file, 'utf8')
  } catch {
    content = ''
  }
  const lineCount = (content.match(/\n/g) ?? []).length
  const now = Math.floor(Date.now() / 1000)
  const data = readHistoryData(content)

  const createdStr = data.createdTs !== '' ? mungeCreated(data.createdTs) : ''
  let ctxStr = '(no usage data)'
  if (data.used !== '' && data.peak !== '') {
    const window = bashNum(data.peak) > 210000 ? 1000000 : 200000
    const pct = Math.trunc((bashNum(data.used) * 100) / window)
    const wlabel = window >= 1000000 ? '1M' : '200k'
    const note = window >= 1000000 ? 'detected 1M' : 'assumed 200k'
    ctxStr = `${data.used} tokens · ${pct}% of ${wlabel} (${note})`
  }

  let laDisplay = data.lastAssistant !== '' ? data.lastAssistant : '(no assistant text)'
  if (data.lastAssistant !== '') {
    const cps = [...data.lastAssistant]
    if (cps.length > 1500) {
      laDisplay =
        `${cps.slice(0, 1500).join('')}\n` +
        `... (${cps.length - 1500} chars truncated; full text in jsonl)`
    }
  }
  const fpDisplay = data.firstPrompt !== '' ? data.firstPrompt : '(no user prompt)'

  const stdout =
    `sid:        ${sidFull}\n` +
    `file:       ${file}\n` +
    `            (${fmtSize(size)} · ${lineCount} lines)\n` +
    `created:    ${createdStr !== '' ? createdStr : '(unknown)'}\n` +
    `last_seen:  ${fmtLocalDateTime(mtime)}  (${fmtAge(now - mtime)} ago)\n` +
    `ctx:        ${ctxStr}\n` +
    '\n' +
    'first prompt:\n' +
    `${indent(fpDisplay)}\n` +
    '\n' +
    'last assistant:\n' +
    `${indent(laDisplay)}\n` +
    '\n' +
    `resume: tm resume ${repo} ${sidFull}\n`
  return { code: 0, stdout, stderr: '' }
}

/**
 * `tm history` — inspect a teammate repo's past sessions. With no second
 * argument it lists every past session; with a sid or sid-prefix it prints
 * that session's detail view.
 */
const history: NativeVerb = async (args, _options, env) => {
  const repo = args[0] ?? ''
  if (repo.length === 0) return die('usage: tm history <repo> [<sid-or-prefix>]')

  const path = join(env.dispatcherDir, repo)
  if (!isDirectory(path)) return dieRepoNotFound('history', repo, path, env.dispatcherDir)

  const projectDir = projectDirForRepo(repo, env)
  const sidArg = args[1] ?? ''
  return sidArg === ''
    ? historyList(repo, projectDir, env)
    : historyDetail(repo, projectDir, sidArg)
}

/**
 * `tm`'s `require_session`: a `die` `TmResult` when the teammate's tmux
 * session does not exist, or `null` when it does. `tm` checks with
 * `has-session -t "=<name>"` — the `=` is tmux's exact-match modifier.
 */
async function requireSession(repo: string, runTmux: TmuxRunner): Promise<TmResult | null> {
  const name = `${SESSION_PREFIX}${repo}`
  let exists = false
  try {
    exists = (await runTmux(['has-session', '-t', `=${name}`])).code === 0
  } catch {
    exists = false
  }
  return exists ? null : die(`no such teammate session: ${repo} (tmux=${name}; try 'tm ls')`)
}

/**
 * `tm`'s `resolve_pane_target`: the tmux internal session id of a teammate's
 * session, or `''` when none matches. `tm` matches the session name exactly
 * against `list-sessions -F '#{session_id} #{session_name}'` — a pane-target
 * call cannot take the `=NAME` modifier, so the id is resolved instead.
 */
async function resolvePaneTarget(repo: string, runTmux: TmuxRunner): Promise<string> {
  const name = `${SESSION_PREFIX}${repo}`
  let listing = ''
  try {
    listing = (await runTmux(['list-sessions', '-F', '#{session_id} #{session_name}'])).stdout
  } catch {
    listing = ''
  }
  for (const line of listing.split('\n')) {
    const space = line.indexOf(' ')
    if (space >= 0 && line.slice(space + 1) === name) return line.slice(0, space)
  }
  return ''
}

/** Pause for `ms` milliseconds — `tm poll`'s inter-poll `sleep 3`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `tm status` — capture a teammate's live pane (a diagnostic verb).
 *
 * Resolves the session, then prints `tmux capture-pane` verbatim: that
 * capture's result *is* the verb's result, exactly as `cmd_status` ends in a
 * bare `capture-pane`. The `lines` argument bounds the scrollback `-S`.
 */
const status: NativeVerb = async (args, _options, env) => {
  const repo = args[0] ?? ''
  if (repo.length === 0) return die('usage: tm status <repo> [lines=80]')
  // `||`, not `??`: `tm`'s `${2:-80}` also defaults on an empty-string arg.
  const lines = args[1] || '80'

  const sessionMissing = await requireSession(repo, env.runTmux)
  if (sessionMissing !== null) return sessionMissing

  const pane = await resolvePaneTarget(repo, env.runTmux)
  if (pane === '') return die(`could not resolve pane target for ${repo}`)

  return env.runTmux(['capture-pane', '-t', pane, '-p', '-S', `-${lines}`])
}

/**
 * `tm poll` — block until a teammate's pane matches a regex, or a timeout
 * elapses (a diagnostic verb).
 *
 * The poll loop is native; the match itself delegates to the real `grep -E`,
 * the way `states` delegates alignment to `column`. `tm`'s `capture-pane |
 * grep -qE` runs under `set -o pipefail`, so a match needs both the capture
 * to succeed and `grep` to exit 0.
 */
const poll: NativeVerb = async (args, _options, env) => {
  const repo = args[0] ?? ''
  const pattern = args[1] ?? ''
  if (repo === '' || pattern === '') {
    return die('usage: tm poll <repo> <regex> [timeout=180]')
  }
  // `||`, not `??`: `tm`'s `${3:-180}` also defaults on an empty-string arg.
  const timeoutArg = args[2] || '180'

  const sessionMissing = await requireSession(repo, env.runTmux)
  if (sessionMissing !== null) return sessionMissing

  const pane = await resolvePaneTarget(repo, env.runTmux)
  if (pane === '') return die(`could not resolve pane target for ${repo}`)

  // `bashNum('3.5')` returns 0 silently; bash's `(( end = ... + 3.5 ))` dies
  // under `set -e` with no output. Match the silent-fail by validating with
  // the same guard `send` / `wait` / `compact` use for their `--timeout`.
  if (!isNonNegativeInteger(timeoutArg)) return { code: 1, stdout: '', stderr: '' }
  const end = Math.floor(Date.now() / 1000) + Number(timeoutArg)
  while (Math.floor(Date.now() / 1000) < end) {
    const capture = await env.runTmux(['capture-pane', '-t', pane, '-p', '-S', '-300'])
    if (capture.code === 0 && (await env.runGrep(pattern, capture.stdout)) === 0) {
      return { code: 0, stdout: `matched: ${pattern}\n`, stderr: '' }
    }
    await sleep(3000)
  }
  return {
    code: 1,
    stdout: '',
    stderr: `tm: timeout after ${timeoutArg}s waiting for /${pattern}/ in ${repo}\n`,
  }
}

/**
 * `tm`'s `clear_idle`: drop a sid's three hook artifacts together — the idle
 * marker, the `.last` text, and the `.busy` marker — so a later wait/last
 * sees the next turn, not a stale one. A no-op for an empty sid, mirroring
 * `clear_idle`'s `[[ -n "$1" ]]` guard.
 */
function clearIdle(sid: string): void {
  if (sid === '') return
  for (const file of [idleMarkerFor(sid), lastFileFor(sid), busyMarkerFor(sid)]) {
    rmSync(file, { force: true })
  }
}

/**
 * `tm kill` — tear a teammate down: clear its hook artifacts, remove its four
 * repo-keyed `/tmp` files, and kill its tmux session. Reports `killed:` when a
 * session was running, `not running:` when none was — `cmd_kill` reproduced.
 *
 * `tm kill` removes the `/tmp` files unconditionally (its `rm -f` no-ops on an
 * absent file), so the verb is the same whether or not the teammate was live.
 */
const kill: NativeVerb = async (args, _options, env) => {
  const repo = args[0] ?? ''
  if (repo.length === 0) return die('usage: tm kill <repo>')
  const name = `${SESSION_PREFIX}${repo}`

  // A recorded sid means there are hook artifacts to clear first.
  const sid = resolveSid(repo)
  if (sid !== null) clearIdle(sid)

  for (const file of [sidFile(repo), sendAtFile(repo), readyFile(repo), cwdFile(repo)]) {
    rmSync(file, { force: true })
  }

  let running = false
  try {
    running = (await env.runTmux(['has-session', '-t', `=${name}`])).code === 0
  } catch {
    running = false
  }
  if (running) {
    await env.runTmux(['kill-session', '-t', `=${name}`])
    return { code: 0, stdout: `killed: ${repo} (tmux=${name})\n`, stderr: '' }
  }
  return { code: 0, stdout: `not running: ${repo} (tmux=${name})\n`, stderr: '' }
}

/**
 * The seed `dispatcher-tasks-archive.md` `tm archive` writes when the archive
 * file does not exist yet — `cmd_archive`'s `ARCHIVE_EOF` heredoc, verbatim.
 */
const ARCHIVE_TEMPLATE = `${[
  '---',
  'name: dispatcher-tasks-archive',
  'description: "On-demand archive of closed dispatcher tasks, compressed to outcome + artifacts. NOT a boot read — only consult when looking up past task history. Live in-flight tasks live in active-dispatcher-tasks.md."',
  'metadata:',
  '  node_type: memory',
  '  type: project',
  '---',
  '',
  '# Dispatcher task archive',
  '',
  'Closed tasks moved here from `active-dispatcher-tasks.md`, compressed to a',
  'pointer + conclusion (not a knowledge base). Newest on top. Reusable analysis',
  'that outlives a task should be promoted to its own memory file, not kept here.',
  '',
  '<!-- split by month (dispatcher-tasks-archive-YYYY-MM.md) if this file grows past a few hundred entries -->',
].join('\n')}\n`

/** The current date as `YYYY-MM-DD` in local time — `tm`'s `date +%Y-%m-%d`. */
function fmtLocalDate(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Split a ledger file into its lines as `grep`/`sed` count them — a trailing
 * newline does not add an empty final line.
 */
function ledgerLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The outcome of parsing `tm archive`'s arguments: an `id`/`status`, or an early exit. */
type ArchiveArgs = { id: string; status: string } | { error: TmResult }

/**
 * Parse `tm archive`'s flags — one positional `id`, an optional `--status` /
 * `--status=` — mirroring `cmd_archive`'s loop. A bare trailing `--status`
 * reproduces `tm`'s quirk: the `shift 2` past the end fails under `set -e`, so
 * `tm` exits 1 with no output.
 */
function parseArchiveArgs(args: readonly string[]): ArchiveArgs {
  let id = ''
  let status = ''
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--status') {
      if (i + 1 >= args.length) return { error: { code: 1, stdout: '', stderr: '' } }
      status = args[i + 1]!
      i++
    } else if (arg.startsWith('--status=')) {
      status = arg.slice('--status='.length)
    } else if (arg.startsWith('-')) {
      return { error: die(`tm archive: unknown flag: ${arg}`) }
    } else if (id === '') {
      id = arg
    } else {
      return { error: die(`tm archive: unexpected arg: ${arg}`) }
    }
  }
  return { id, status }
}

/**
 * `tm archive` — move a finished task from the active dispatcher ledger to the
 * archive. It cuts the entry block out of `active-dispatcher-tasks.md`, copies
 * repo/branch/intent from it, stamps the close date and the outcome (read from
 * stdin), and prepends a compressed entry to `dispatcher-tasks-archive.md`,
 * creating that file from its template when it does not exist. `cmd_archive`
 * reproduced, including the grep-located block and the `[status]`-tag carry.
 */
const archive: NativeVerb = async (args, options, env) => {
  const parsed = parseArchiveArgs(args)
  if ('error' in parsed) return parsed.error
  const { id } = parsed
  if (id === '') {
    return die("usage: tm archive <id> [--status '<tag>']   (outcome text on stdin)")
  }

  const memoryDir = join(env.projectsDir, encodeProjectDir(env.dispatcherDir), 'memory')
  const activePath = join(memoryDir, 'active-dispatcher-tasks.md')
  const archivePath = join(memoryDir, 'dispatcher-tasks-archive.md')
  if (!isRegularFile(activePath)) return die(`no active ledger at ${activePath}`)

  // The outcome is read from stdin so multi-word / URL text needs no quoting.
  const outcome = (options?.stdin ?? '').replace(/\n+$/, '')
  if (outcome.replace(/\s/g, '') === '') {
    return die(`outcome text required on stdin, e.g.:  echo '...' | tm archive ${id}`)
  }

  const activeContent = readFileSync(activePath, 'utf8')
  const activeLines = ledgerLines(activeContent)

  // Locate the entry block. The header carries a trailing status tag, so the
  // id is matched by prefix: `### <id>` then whitespace or end-of-line. `tm`
  // interpolates the id straight into the `grep -E` pattern; an id `grep`
  // cannot compile (a stray metacharacter) finds nothing, like `tm`'s.
  let headerRe: RegExp
  try {
    headerRe = new RegExp(`^### ${id}(\\s|$)`)
  } catch {
    headerRe = /(?!)/
  }
  const headerLines = activeLines
    .map((line, index) => (headerRe.test(line) ? index + 1 : 0))
    .filter((lineNo) => lineNo > 0)
  if (headerLines.length === 0) {
    const available = activeLines
      .map((line) => /^### [^ ]+/.exec(line)?.[0])
      .filter((match): match is string => match != null)
      .map((match) => match.slice('### '.length))
      .join(' ')
    return die(`id not found in active ledger: ${id}\n  available: ${available}`)
  }
  if (headerLines.length !== 1) {
    return die(`id matches ${headerLines.length} entries in active ledger: ${id}`)
  }

  // The block runs from its header to the line before the next `### `/`## `
  // header, or to the last line (`wc -l`) when none follows.
  const start = headerLines[0]!
  const total = (activeContent.match(/\n/g) ?? []).length
  let end = total
  for (let index = start; index < activeLines.length; index++) {
    if (/^(### |## )/.test(activeLines[index]!)) {
      end = index
      break
    }
  }
  const blockLines = activeLines.slice(start - 1, end)

  // Carry the header's `[tag]` as the status unless `--status` overrode it.
  let status = parsed.status
  if (status === '') {
    const tag = /\[(.+)\]\s*$/.exec(blockLines[0] ?? '')
    status = tag ? tag[1]! : 'done'
  }

  const field = (name: string): string => {
    const line = blockLines.find((candidate) => candidate.startsWith(`- ${name}:`))
    if (line === undefined) return '(unknown)'
    const value = line.slice(`- ${name}:`.length).replace(/^\s*/, '')
    return value === '' ? '(unknown)' : value
  }
  const entry =
    `### ${id}  [${status}]\n` +
    `- repo/branch: ${field('repo')} / ${field('branch')}\n` +
    `- intent: ${field('intent')}\n` +
    `- outcome: ${outcome}\n` +
    `- closed: ${fmtLocalDate()}`

  // Prepend the entry to the archive — above its first `### ` entry, or after
  // the header block when it has none. The archive is seeded if it is absent.
  const archiveContent = isRegularFile(archivePath)
    ? readFileSync(archivePath, 'utf8')
    : ARCHIVE_TEMPLATE
  const archiveLines = ledgerLines(archiveContent)
  let firstEntry = 0
  for (let index = 0; index < archiveLines.length; index++) {
    if (archiveLines[index]!.startsWith('### ')) {
      firstEntry = index + 1
      break
    }
  }
  let newArchive: string
  if (firstEntry > 0) {
    const head =
      firstEntry > 1 ? `${archiveLines.slice(0, firstEntry - 1).join('\n')}\n` : ''
    const tail = `${archiveLines.slice(firstEntry - 1).join('\n')}\n`
    newArchive = `${head}${entry}\n\n${tail}`
  } else {
    newArchive = `${archiveContent}\n${entry}\n`
  }

  // Remove the original block from the active ledger.
  const remaining = [...activeLines.slice(0, start - 1), ...activeLines.slice(end)]
  const newActive = remaining.length > 0 ? `${remaining.join('\n')}\n` : ''

  writeFileSync(archivePath, newArchive)
  writeFileSync(activePath, newActive)
  return {
    code: 0,
    stdout:
      `archived ${id}  [${status}] -> dispatcher-tasks-archive.md  ` +
      '(removed from active ledger)\n',
    stderr: '',
  }
}

/**
 * `tm reload` — fan `/reload-plugins` out to one, many, or all teammates.
 *
 * The verb is sugar over `tm send --no-wait <repo> --prompt /reload-plugins`.
 * Argument parsing and the repo fan-out are native; each teammate's send
 * dispatches into the native `send` handler in-process — no subprocess.
 *
 * `cmd_reload`'s `(failed — ...)` line and keep-iterating `rc` are dead code:
 * `cmd_send`'s `_send_keys` `die`s (`exit 1`) for a non-running teammate
 * rather than returning non-zero, which terminates `tm reload` outright. So
 * `reload` reproduces what `tm reload` *does* — stop at the first send that
 * exits non-zero, and propagate that exit code — not the unreachable intent.
 */
const reload: NativeVerb = async (args, _options, env) => {
  let all = false
  const repos: string[] = []
  for (const arg of args) {
    if (arg === '--all') all = true
    else if (arg === '-h' || arg === '--help') return die('usage: tm reload <repo>... | --all')
    else if (arg.startsWith('-')) return die(`tm reload: unknown flag: ${arg}`)
    else repos.push(arg)
  }

  if (all) {
    if (repos.length > 0) return die('tm reload: --all conflicts with explicit repos')
    repos.push(...(await iterRepos(env.runTmux)))
    if (repos.length === 0) {
      return { code: 0, stdout: '(no teammate sessions to reload)\n', stderr: '' }
    }
  } else if (repos.length === 0) {
    return die('usage: tm reload <repo>... | --all')
  }

  let stdout = ''
  for (const repo of repos) {
    stdout += `→ ${repo}: /reload-plugins\n`
    const sent = await send(['--no-wait', repo, '--prompt', '/reload-plugins'], undefined, env)
    // A non-zero `tm send` is the `_send_keys` `die` that ends `tm reload`;
    // its own stderr went to `cmd_reload`'s `>/dev/null`, so it is dropped.
    if (sent.code !== 0) return { code: sent.code, stdout, stderr: '' }
  }
  return { code: 0, stdout, stderr: '' }
}

// --- shared helpers for the hot-path verbs --------------------------------
//
// `spawn`, `send`, `wait`, `compact`, and `resume` drive a real `claude` REPL
// through tmux and the `/tmp/claude-idle` protocol. They share three building
// blocks that mirror `bin/tm`'s `_send_keys`, `_wait_idle_signal`, and
// `_print_last_or_empty` — kept in one place so a future fix lands across
// every verb that composes them.

/** `resolveSid` that dies with `tm`'s shared error when the sid is missing. */
function resolveSidOrDie(repo: string): { sid: string } | { error: TmResult } {
  const sid = resolveSid(repo)
  if (sid === null) {
    return {
      error: die(
        `no sid file for ${repo} at ${sidFile(repo)} — was this teammate ` +
          "spawned via 'tm spawn'? (raw 'tmux new-session' won't seed the sid)",
      ),
    }
  }
  return { sid }
}

/** `tm`'s `new_sid`: a lowercase UUID — Claude Code normalizes sids to lower. */
function newSid(): string {
  return randomUUID().toLowerCase()
}

/** `tm`'s `rand_suffix`: 4 chars drawn from `[a-z0-9]`. */
function randSuffix(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = randomBytes(4)
  let out = ''
  for (let i = 0; i < 4; i++) out += alphabet[bytes[i]! % alphabet.length]
  return out
}

/**
 * `tm`'s `sanitize_task_slug`: lowercase ASCII alnum + CJK Unified Ideographs
 * (U+4E00–U+9FFF) survive; every other code point collapses to a single `-`.
 * Leading/trailing `-` stripped, capped at 30 code points (re-trimmed if the
 * cap landed inside a run of separators). Empty result → empty string; the
 * caller checks for that and rejects the slug.
 */
function sanitizeTaskSlug(task: string): string {
  let s = task.toLowerCase()
  // The character class mirrors the perl regex: ASCII a-z0-9 plus the CJK
  // Unified Ideographs block. Any other code point — punctuation, whitespace,
  // hiragana, katakana, hangul, emoji — becomes a single `-`.
  s = s.replace(/[^a-z0-9一-鿿]+/g, '-')
  s = s.replace(/^-+|-+$/g, '')
  const cps = [...s]
  if (cps.length > 30) {
    s = cps.slice(0, 30).join('')
    s = s.replace(/-+$/, '')
  }
  return s
}

/** Resolve after `ms` milliseconds — same helper poll-based verbs reach for. */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Epoch seconds, sampled once — `tm`'s `$(date +%s)`. */
function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Whether `value` is a valid non-negative integer string (the shape `tm`'s
 * `[[ "$timeout" =~ ^[0-9]+$ ]]` accepts). `tm` does not validate timeouts
 * itself before passing them to `date +%s` / `sleep`; the native check is a
 * narrower guard so a malformed `--timeout` does not become a NaN loop.
 */
function isNonNegativeInteger(value: string): boolean {
  return /^[0-9]+$/.test(value)
}

/**
 * The runtime knobs `_send_keys` reads from the environment — the bounded
 * defaults are the same constants `bin/tm` uses, and the env vars override
 * them at the same names (`TM_SEND_INLINE_MAX`, `TM_SEND_GAP`).
 */
interface SendKeysConfig {
  /** Max prompt size (in chars) to take the inline `send-keys -l + Enter` path. */
  inlineMax: number
  /** Optional override (in seconds) for the post-paste settle gap. */
  gapOverride: string | null
}

/**
 * Parse the env knobs for `_send_keys` once per call — `tm`'s validation
 * mirrored verbatim: a malformed value dies up front rather than crashing
 * the script mid-flow (which would strand the prompt in the input box).
 */
function readSendKeysConfig(): SendKeysConfig | TmResult {
  const inlineRaw = process.env.TM_SEND_INLINE_MAX ?? ''
  const inlineMax = inlineRaw === '' ? 200 : Number(inlineRaw)
  if (inlineRaw !== '' && !/^[0-9]+$/.test(inlineRaw)) {
    return die(
      `TM_SEND_INLINE_MAX must be a non-negative integer (got: '${inlineRaw}')`,
    )
  }
  const gapRaw = process.env.TM_SEND_GAP ?? ''
  if (gapRaw !== '' && !/^[0-9]+(\.[0-9]+)?$/.test(gapRaw)) {
    return die(
      `TM_SEND_GAP must be a non-negative number of seconds (got: '${gapRaw}')`,
    )
  }
  return {
    inlineMax,
    gapOverride: gapRaw === '' ? null : gapRaw,
  }
}

/** `tm`'s size-based default paste-buffer settle gap, in seconds. */
function defaultPasteGapSec(promptLength: number): number {
  if (promptLength <= 256) return 0.2
  if (promptLength <= 1024) return 0.5
  if (promptLength <= 4096) return 1.0
  if (promptLength <= 16384) return 2.0
  return 4.0
}

/**
 * `tm`'s `_send_keys`: push a prompt into the teammate's pane.
 *
 * Two delivery modes by size — short single-line prompts take the inline
 * `send-keys -l + Enter` fast path; larger or multi-line prompts stage the
 * bytes in a named tmux buffer and `paste-buffer -p -r` them in a single
 * bracketed-paste sequence, then send Enter after the trailing `\e[201~`
 * marker so the TUI submits the buffered text as one prompt. Both modes
 * clear the idle/.last/.busy baseline first and touch `<repo>.send-at`.
 *
 * Returns the `TmResult` that `cmd_send`'s "sent to ..." preamble plus the
 * "sid=..." line make up; the verb wrapper appends its own follow-on lines.
 */
async function sendKeys(
  repo: string,
  prompt: string,
  env: NativeEnv,
): Promise<TmResult> {
  const sessionMissing = await requireSession(repo, env.runTmux)
  if (sessionMissing !== null) return sessionMissing

  const pane = await resolvePaneTarget(repo, env.runTmux)
  if (pane === '') return die(`could not resolve pane target for ${repo}`)

  const cfg = readSendKeysConfig()
  if ('code' in cfg) return cfg

  // Clear the idle baseline before sending so the subsequent wait reflects
  // THIS turn, not a prior one. A no-sid case is the fresh-spawn path where
  // there is no prior turn to clear.
  const sid = resolveSid(repo)
  if (sid !== null) clearIdle(sid)

  // `tm`'s `: > "$(send_at_file "$repo")"` — touch the marker. mkdir the
  // parent in case /tmp/teammate-*.send-at is somehow on a non-/tmp path.
  const sa = sendAtFile(repo)
  mkdirSync(dirname(sa), { recursive: true })
  writeFileSync(sa, '')

  const n = prompt.length
  const inlinePath = n <= cfg.inlineMax && !prompt.includes('\n')

  const name = `${SESSION_PREFIX}${repo}`
  let stderr = `sent to ${repo} (tmux=${name})\n`
  if (sid !== null) stderr += `sid=${sid}\n`

  // `bin/tm` runs under `set -euo pipefail`, so a failed `tmux send-keys` /
  // `load-buffer` / `paste-buffer` aborts the script before the verb claims
  // success. Mirror that: any non-zero tmux exit fails the verb so the
  // dispatcher does not later block on a Stop hook that will never fire.
  const tmuxOk = (result: { code: number; stderr: string }, what: string): TmResult | null =>
    result.code === 0
      ? null
      : die(`tmux ${what} failed: ${result.stderr.trim() || 'non-zero exit'}`)

  if (inlinePath) {
    const sent = await env.runTmux(['send-keys', '-t', pane, '-l', prompt])
    const sentErr = tmuxOk(sent, 'send-keys')
    if (sentErr !== null) return sentErr
    const enter = await env.runTmux(['send-keys', '-t', pane, 'Enter'])
    const enterErr = tmuxOk(enter, 'send-keys Enter')
    if (enterErr !== null) return enterErr
    return { code: 0, stdout: '', stderr }
  }

  const gap = cfg.gapOverride !== null ? Number(cfg.gapOverride) : defaultPasteGapSec(n)
  const buf = `tm-send-${process.pid}-${randomBytes(2).toString('hex')}`
  let loaded = false
  try {
    const loadResult = await env.runTmux(['load-buffer', '-b', buf, '-'], { stdin: prompt })
    const loadErr = tmuxOk(loadResult, 'load-buffer')
    if (loadErr !== null) return loadErr
    loaded = true
    const pasteResult = await env.runTmux([
      'paste-buffer',
      '-p',
      '-r',
      '-d',
      '-b',
      buf,
      '-t',
      pane,
    ])
    const pasteErr = tmuxOk(pasteResult, 'paste-buffer')
    if (pasteErr !== null) return pasteErr
    // `paste-buffer -d` deletes the buffer on success; `loaded` is reset so
    // the finally block's defensive delete is a no-op for the normal path.
    loaded = false
    await sleepMs(Math.round(gap * 1000))
    const enter = await env.runTmux(['send-keys', '-t', pane, 'Enter'])
    const enterErr = tmuxOk(enter, 'send-keys Enter')
    if (enterErr !== null) return enterErr
  } finally {
    // Mirror `tm`'s RETURN trap: a `paste-buffer` that failed after
    // `load-buffer` succeeded would otherwise leak a named buffer entry.
    if (loaded) {
      try {
        await env.runTmux(['delete-buffer', '-b', buf])
      } catch {
        // Best effort — `tm` swallows this too (`2>/dev/null || true`).
      }
    }
  }
  return { code: 0, stdout: '', stderr }
}

/**
 * `tm`'s `_wait_idle_signal`: block until `/tmp/claude-idle/<sid>` exists, or
 * `timeoutSec` elapses. Returns the resolved `TmResult` on early-out
 * (no-such-session / no-sid), or `{ ok }` once the loop has its verdict.
 */
async function waitIdleSignal(
  repo: string,
  timeoutSec: number,
  fresh: boolean,
  env: NativeEnv,
): Promise<TmResult | { ok: boolean }> {
  const sessionMissing = await requireSession(repo, env.runTmux)
  if (sessionMissing !== null) return sessionMissing
  const sidR = resolveSidOrDie(repo)
  if ('error' in sidR) return sidR.error
  if (fresh) clearIdle(sidR.sid)

  const end = nowSec() + timeoutSec
  const marker = idleMarkerFor(sidR.sid)
  while (nowSec() < end) {
    if (existsSync(marker)) return { ok: true }
    await sleepMs(3000)
  }
  return { ok: false }
}

/**
 * `tm`'s `_wait_pane_quiet`: block until the teammate's pane has shown no
 * busy marker for ~4s AND at least 3s have passed since the last send.
 * Returns the resolved `TmResult` on early-out or `{ ok }` once decided.
 */
async function waitPaneQuiet(
  repo: string,
  timeoutSec: number,
  env: NativeEnv,
): Promise<TmResult | { ok: boolean }> {
  const sessionMissing = await requireSession(repo, env.runTmux)
  if (sessionMissing !== null) return sessionMissing

  let sendAt = 0
  try {
    const sa = sendAtFile(repo)
    sendAt = Math.floor(statSync(sa).mtimeMs / 1000)
  } catch {
    sendAt = 0
  }

  const end = nowSec() + timeoutSec
  let quietStreak = 0
  while (nowSec() < end) {
    const sid = resolveSid(repo)
    const isBusy = sid !== null && isRegularFile(busyMarkerFor(sid))
    if (isBusy) quietStreak = 0
    else quietStreak += 1
    if (quietStreak >= 2 && nowSec() - sendAt >= 3) return { ok: true }
    await sleepMs(2000)
  }
  return { ok: false }
}

/**
 * `tm`'s `_print_last_or_empty`: print the teammate's `<sid>.last` to stdout,
 * or — when the file is missing or zero-byte — the documented sentinel line.
 * Always exit 0; the verb wrapper decides what code to ship.
 */
function printLastOrEmpty(repo: string): string {
  const sid = resolveSid(repo)
  if (sid === null) return `(no sid for ${repo})\n`
  const reply = readIfNonEmpty(lastFileFor(sid))
  if (reply === null) {
    return '(no text reply this turn — tool-only, /compact, /clear, or fresh spawn)\n'
  }
  // `cat` does not append a newline; the file's own trailing newline is what
  // shapes the printed line. Reproduce that verbatim.
  return reply
}

/**
 * `tm`'s `_echo_ctx_to_stderr`: the teammate's post-turn ctx line, prefixed
 * with `ctx: `, on stderr. Soft-fails: an unreadable transcript or a sid that
 * cannot be resolved drops the line silently (`tm`'s `2>/dev/null`).
 */
function echoCtxToStderr(repo: string, env: NativeEnv): string {
  // Reuse `ctxLine` — its `?` diagnostic shape would also be a soft-fail, so
  // any `repo:` prefix indicates an unreadable transcript; only the formatted
  // success line is echoed (the part after `<repo>: `).
  const body = ctxLine(repo, '', env)
  // The diagnostic forms always start with `<repo>: ?`; the success form
  // starts with `<repo>: <digits> tokens · ...`.
  if (body.includes(': ? (')) return ''
  const prefix = `${repo}: `
  const data = body.startsWith(prefix) ? body.slice(prefix.length) : body
  return `ctx: ${data}\n`
}

// --- doctor ---------------------------------------------------------------

/**
 * `tm`'s `cmd_doctor` — a read-only environment self-check. Sections fire
 * top-down: the `tm` executable, the dispatcher dir, tmux, the idle dir,
 * and the active teammate list. Soft-fails throughout (every probe is
 * guarded) and always exits 0; output is meant to be eyeballed, not parsed.
 *
 * The path the "tm executable" section reports is this module's own
 * `bin/tm` wrapper (`core/bin/tm`), not the bash `bin/tm`. Bash is the
 * stage-3 oracle; once stage 3c retires it, the Node CLI is the only `tm`
 * binary that exists.
 */
const doctor: NativeVerb = async (args, _options, env) => {
  if (args.length > 0) {
    return die(`tm doctor: takes no arguments (got: ${args.join(' ')})`)
  }

  // The kv row: a 20-character padded label, then the value — matches
  // `cmd_doctor`'s `printf '  %-20s%s\n'`. One source of truth here keeps
  // alignment immune to label renames.
  const kv = (label: string, value: string): string => {
    const padded = `${label}:`.padEnd(20, ' ')
    return `  ${padded}${value}\n`
  }

  let out = ''

  // --- tm executable ---
  // This module lives at `core/src/native.ts`; the Node CLI wrapper sits at
  // `core/bin/tm`, and the plugin manifest at `<plugin-root>/.claude-plugin/
  // plugin.json`. Resolve both relative to this file so the answer survives
  // a renamed plugin directory.
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const tmWrapper = join(moduleDir, '..', 'bin', 'tm')
  const pluginJson = join(moduleDir, '..', '..', '.claude-plugin', 'plugin.json')
  let version = 'unknown'
  let pluginJsonPresent = false
  try {
    if (statSync(pluginJson).isFile()) {
      pluginJsonPresent = true
      const parsed = JSON.parse(readFileSync(pluginJson, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        version = parsed.version
      }
    }
  } catch {
    pluginJsonPresent = false
  }
  out += 'tm executable:\n'
  out += kv('path', tmWrapper)
  out += kv('version', version)
  if (!pluginJsonPresent) out += kv('note', `plugin.json not found at ${pluginJson}`)
  out += '\n'

  // --- dispatcher dir ---
  out += 'dispatcher dir:\n'
  out += kv('resolved', env.dispatcherDir)
  const envSet = process.env.TM_DISPATCHER_DIR
  if (envSet !== undefined && envSet.length > 0) {
    out += kv('TM_DISPATCHER_DIR', `set (= ${envSet})`)
  } else {
    out += kv(
      'TM_DISPATCHER_DIR',
      'unset — falling back to $PWD (run /claudemux:setup to inoculate against cwd drift)',
    )
  }
  const pwd = process.cwd()
  out += kv('$PWD', pwd)
  if (env.dispatcherDir !== pwd) {
    out += kv(
      'status',
      'DIVERGED — dispatcher dir != $PWD; env override is currently keeping tm correct despite the drifted PWD',
    )
  } else {
    out += kv('status', 'matched')
  }
  if (!isDirectory(env.dispatcherDir)) {
    out += kv('warning', `${env.dispatcherDir} does not exist as a directory`)
  }
  out += '\n'

  // --- tmux ---
  out += 'tmux:\n'
  let tmuxVersionOk = false
  let tmuxVersionLine = ''
  try {
    const versionResult = await env.runTmux(['-V'])
    if (versionResult.code === 0) {
      tmuxVersionOk = true
      tmuxVersionLine = versionResult.stdout.split('\n')[0] ?? '?'
    }
  } catch {
    tmuxVersionOk = false
  }
  if (!tmuxVersionOk) {
    out += kv('installed', 'no (tmux not on PATH — claudemux teammate workflow needs it)')
  } else {
    out += kv('installed', `yes (${tmuxVersionLine})`)
    let serverRunning = false
    try {
      serverRunning = (await env.runTmux(['info'])).code === 0
    } catch {
      serverRunning = false
    }
    if (serverRunning) out += kv('server', 'running')
    else out += kv('server', "not running (no sessions exist yet — that's fine pre-spawn)")
    const insideTmux = process.env.TMUX ?? ''
    if (insideTmux.length > 0) out += kv('in tmux', `yes (TMUX=${insideTmux})`)
    else out += kv('in tmux', 'no — tm is being run from outside a tmux session')
  }
  out += '\n'

  // --- idle dir ---
  out += `idle dir (${idleDir()}):\n`
  if (isDirectory(idleDir())) {
    let count = 0
    try {
      count = readdirSync(idleDir()).length
    } catch {
      count = 0
    }
    out += kv('exists', `yes (${count} file(s))`)
  } else {
    out += kv('exists', 'no — gets created on first tm spawn / scripts/setup.sh')
  }
  out += '\n'

  // --- active teammates ---
  // `cmd_doctor` projects each `tmux ls` row to its session field (`awk -F:
  // ... {print $1}`) and prints it with a two-space indent — bare session
  // name, not the full row. Mirror that exactly so the report stays
  // byte-compatible with the bash form for this section.
  out += 'active teammates:\n'
  let listing = ''
  try {
    listing = (await env.runTmux(['ls'])).stdout
  } catch {
    listing = ''
  }
  const sessionRows = listing
    .split('\n')
    .map((line) => sessionField(line))
    .filter((name) => name.startsWith(SESSION_PREFIX))
  if (sessionRows.length === 0) {
    out += "  (none — use 'tm spawn <repo>' to launch one)\n"
  } else {
    out += kv('count', String(sessionRows.length))
    for (const name of sessionRows) out += `  ${name}\n`
  }

  return { code: 0, stdout: out, stderr: '' }
}

// --- spawn ----------------------------------------------------------------

/** Parsed arg vector for `tm spawn`, after `parseSpawnArgs`. */
interface SpawnArgs {
  resumeSid: string
  task: string
  prompt: string
  hasPrompt: boolean
  noWait: boolean
}

/**
 * `cmd_spawn`'s arg loop. `--prompt` is the only value-bearing flag bash
 * validates explicitly (`[[ $# -ge 2 ]] || die`); `--task` and `--resume`
 * use `"${2:-}"; shift 2`, which under `set -e` exits silently when the
 * value is missing because `shift 2` past the end returns non-zero — the
 * conformance ledger calls this the "tm exits 1 with no output" shape.
 */
function parseSpawnArgs(rest: readonly string[]): SpawnArgs | { error: TmResult } {
  const SILENT: TmResult = { code: 1, stdout: '', stderr: '' }
  let resumeSid = ''
  let task = ''
  let prompt = ''
  let hasPrompt = false
  let noWait = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === '--resume') {
      if (i + 1 >= rest.length) return { error: SILENT }
      resumeSid = rest[i + 1]!
      i++
    } else if (arg === '--task') {
      if (i + 1 >= rest.length) return { error: SILENT }
      task = rest[i + 1]!
      i++
    } else if (arg.startsWith('--task=')) {
      task = arg.slice('--task='.length)
    } else if (arg === '--prompt') {
      if (i + 1 >= rest.length) return { error: die('tm spawn: --prompt requires a value') }
      prompt = rest[i + 1]!
      hasPrompt = true
      i++
    } else if (arg.startsWith('--prompt=')) {
      prompt = arg.slice('--prompt='.length)
      hasPrompt = true
    } else if (arg === '--no-wait') {
      noWait = true
    } else {
      return { error: die(`unknown flag: ${arg}`) }
    }
  }
  return { resumeSid, task, prompt, hasPrompt, noWait }
}

/**
 * Single-quote-escape a string for safe embedding in a bash command line.
 * `tm`'s shell-out builds the `claude --session-id ... -n '...'` string and
 * passes it to `tmux send-keys`; the native form constructs the same string
 * so the running REPL's argv is byte-equal to bash's.
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * `tm`'s `teammate_launch_flags`: the flag string between `claude --session-id|
 * --resume <sid>` and an optional `-n '<name>'`. A bare tool name in
 * `--disallowedTools` drops it from the model's context entirely — see the
 * `help_spawn` text for the AskUserQuestion rationale.
 */
function teammateLaunchFlags(mdExcludes: string): string {
  return `--settings ${shellSingleQuote(mdExcludes)} --disallowedTools AskUserQuestion`
}

/** Whether a session of this name is currently up — `has-session -t "=NAME"`. */
async function sessionExists(name: string, runTmux: TmuxRunner): Promise<boolean> {
  try {
    return (await runTmux(['has-session', '-t', `=${name}`])).code === 0
  } catch {
    return false
  }
}

/**
 * Run `tm spawn`'s readiness poll: block until `<repo>.ready` appears or 18s
 * (60 × 0.3s) elapse. Returns the ms it took to fire, or `null` on timeout —
 * the caller prints the verb's stderr accordingly.
 */
async function pollReady(repo: string): Promise<number | null> {
  const rf = readyFile(repo)
  for (let i = 1; i <= 60; i++) {
    if (existsSync(rf)) return i * 300
    await sleepMs(300)
  }
  return null
}

/**
 * `tm spawn` — launch a teammate (or relaunch via `--resume <sid>`), record
 * its sid + cwd, and either return as soon as `SessionStart` fires or hand
 * off to a sync `tm send` when `--prompt` is set.
 *
 * Repository discipline: this verb writes the `<repo>.cwd` / `<repo>.sid`
 * markers and the empty `<sid>.last` sentinel; the SessionStart hook
 * separately produces the `<repo>.ready` marker the poll above blocks on.
 * Tearing those apart is what makes `tm spawn --prompt` atomic — the
 * pre-send sleep happens against a REPL that has already booted.
 */
const spawn: NativeVerb = async (args, _options, env) => {
  const repo = args[0] ?? ''
  if (repo.length === 0) {
    return die('usage: tm spawn <repo> [--task <slug>] [--prompt "..."] [--no-wait]')
  }
  const parsed = parseSpawnArgs(args.slice(1))
  if ('error' in parsed) return parsed.error
  const { resumeSid, task, prompt, hasPrompt, noWait } = parsed

  if (noWait && !hasPrompt) {
    return die(
      'tm spawn: --no-wait is only valid with --prompt (a fresh spawn without ' +
        'a prompt already returns as soon as the REPL is ready)',
    )
  }

  const path = join(env.dispatcherDir, repo)
  if (!isDirectory(path)) return dieRepoNotFound('spawn', repo, path, env.dispatcherDir)

  // Physical-path normalization (`cd && pwd -P`) — the SessionStart hook
  // byte-matches against the cwd Claude Code emits in its hook payload,
  // which is always the physical path (macOS resolves `/tmp` → `/private/
  // tmp` at that level), so the recorded `.cwd` must be physical too.
  const cwdPhys = realpathSync(path)
  const dispatcherPhys = realpathSync(env.dispatcherDir)
  const mdExcludes = JSON.stringify({
    claudeMdExcludes: [
      `${dispatcherPhys}/CLAUDE.md`,
      `${dispatcherPhys}/CLAUDE.local.md`,
    ],
  })

  // Display-name selection: `--task` → `<repo>-<sanitized>`, else
  // `<repo>-<rand4>` for a fresh spawn, else empty (preserve on `--resume`).
  let displayName = ''
  if (task.length > 0) {
    const slug = sanitizeTaskSlug(task)
    if (slug.length === 0) {
      return die(
        `tm spawn: --task '${task}' has no usable characters after sanitization ` +
          '(allowlist: ASCII letters/digits + CJK Unified Ideographs)',
      )
    }
    displayName = `${repo}-${slug}`
  } else if (resumeSid.length === 0) {
    displayName = `${repo}-${randSuffix()}`
  }

  const name = `${SESSION_PREFIX}${repo}`
  if (await sessionExists(name, env.runTmux)) {
    if (hasPrompt) {
      return die(
        `${repo} already exists (tmux=${name}) — atomic bootstrap rejected ` +
          'because the teammate is already running. Use ' +
          `'tm send ${repo} --prompt "…"' to drive an existing teammate, or ` +
          `'tm kill ${repo}' first to start over.`,
      )
    }
    return {
      code: 0,
      stdout:
        `${repo} already exists (tmux=${name}; use 'tm status ${repo}' to view, ` +
        `or 'tm kill ${repo}' first)\n`,
      stderr: '',
    }
  }

  // Clear the readiness signal BEFORE launching `claude`. The SessionStart
  // hook re-touches the file once the REPL is up; the poll below blocks on it.
  const rf = readyFile(repo)
  rmSync(rf, { force: true })

  // Record the teammate's physical cwd in place *before* spawning so the
  // hook fires can find it on its first attempt.
  const cf = cwdFile(repo)
  mkdirSync(dirname(cf), { recursive: true })
  writeFileSync(cf, `${cwdPhys}\n`)

  // `-P -F '#{session_id}'` returns the new session's internal id; use it
  // as the subsequent `send-keys` target so prefix-match cannot wrong-route.
  // `-e CLAUDEMUX_TEAMMATE_REPO=...` is the positive identity gate the
  // on-session-start hook reads to discriminate "this teammate" from "the
  // dispatcher happens to share the cwd".
  let paneId = ''
  try {
    const newSession = await env.runTmux([
      'new-session',
      '-d',
      '-s',
      name,
      '-c',
      cwdPhys,
      '-e',
      `CLAUDEMUX_TEAMMATE_REPO=${repo}`,
      '-P',
      '-F',
      '#{session_id}',
    ])
    if (newSession.code !== 0) {
      return die(`tmux new-session failed: ${newSession.stderr.trim() || newSession.stdout.trim()}`)
    }
    paneId = newSession.stdout.split('\n')[0] ?? ''
  } catch (err) {
    return die(`tmux new-session failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (paneId.length === 0) return die(`tmux new-session returned no session id for ${repo}`)

  const sid = resumeSid.length > 0 ? resumeSid : newSid()
  const launchFlags = teammateLaunchFlags(mdExcludes)
  const nameArg = displayName.length > 0 ? ` -n ${shellSingleQuote(displayName)}` : ''
  const launchCmd =
    resumeSid.length > 0
      ? `claude --resume ${sid} ${launchFlags}${nameArg}`
      : `claude --session-id ${sid} ${launchFlags}${nameArg}`
  await env.runTmux(['send-keys', '-t', paneId, launchCmd, 'Enter'])

  let stderr = ''
  if (resumeSid.length > 0) {
    const nameNote = displayName.length > 0 ? `, name=${displayName}` : ''
    stderr += `spawned: ${repo} (tmux=${name}, cwd=${cwdPhys}, resumed sid=${sid}${nameNote})\n`
  } else {
    const nameNote = displayName.length > 0 ? `, name=${displayName}` : ''
    stderr += `spawned: ${repo} (tmux=${name}, cwd=${cwdPhys}, sid=${sid}${nameNote})\n`
  }

  const sf = sidFile(repo)
  mkdirSync(dirname(sf), { recursive: true })
  writeFileSync(sf, `${sid}\n`)
  clearIdle(sid)

  // Fresh-spawn `.last` sentinel — keeps `tm last` reporting "no reply yet"
  // until the first real Stop. Resume mode skips this: the resumed session's
  // last-turn text is context the dispatcher may want to re-read.
  if (resumeSid.length === 0) {
    mkdirSync(idleDir(), { recursive: true })
    writeFileSync(lastFileFor(sid), '')
  }

  const readyAfter = await pollReady(repo)
  if (readyAfter !== null) {
    stderr += `ready: ${repo} (tmux=${name}, SessionStart fired after ~${readyAfter} ms)\n`
  } else {
    stderr +=
      `WARN: ${repo} (tmux=${name}) did not signal ready within 18s ` +
      "(no SessionStart hook fire — the plugin's on-session-start.sh may not " +
      'be loaded, or claude failed to boot). Continuing, but if the REPL is ' +
      "actually dead, a subsequent sync 'tm send' / 'tm spawn --prompt' / " +
      "'tm compact' will block until its --timeout expires (default 1800s). " +
      `'tm status ${repo}' shows the live pane if you need to verify.\n`
  }

  if (!hasPrompt) {
    return { code: 0, stdout: '', stderr }
  }

  // Atomic bootstrap: settle, then hand off to `tm send`. `cmd_send`'s
  // stdout (and its `ctx:` stderr echo) become the spawn verb's stdout/stderr
  // so the dispatcher sees one round-trip's worth of output for the whole
  // sequence.
  await sleepMs(3000)
  const sendArgs: string[] = []
  if (noWait) sendArgs.push('--no-wait')
  sendArgs.push(repo, '--prompt', prompt)
  const sendResult = await send(sendArgs, undefined, env)
  return {
    code: sendResult.code,
    stdout: sendResult.stdout,
    stderr: stderr + sendResult.stderr,
  }
}

// --- send -----------------------------------------------------------------

/** Parsed arg vector for `tm send`, after `parseSendArgs`. */
interface SendArgs {
  repo: string
  prompt: string
  hasPrompt: boolean
  noWait: boolean
  paneQuiet: boolean
  timeout: string
}

/**
 * `cmd_send`'s arg loop. Catches the legacy "tm send repo run tests" form
 * with a dedicated error — pre-0.3.0 callers passed prompts as positional
 * args, and this catches that habit explicitly rather than swallowing the
 * trailing positionals as a confusing "unknown arg".
 */
function parseSendArgs(args: readonly string[]): SendArgs | { error: TmResult } {
  let noWait = false
  let paneQuiet = false
  let timeout = '1800'
  let repo = ''
  let prompt = ''
  let hasPrompt = false
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--no-wait') {
      noWait = true
      i++
    } else if (arg === '--pane-quiet') {
      paneQuiet = true
      i++
    } else if (arg === '--timeout') {
      if (i + 1 >= args.length) return { error: die('tm send: --timeout requires a value') }
      timeout = args[i + 1]!
      i += 2
    } else if (arg.startsWith('--timeout=')) {
      timeout = arg.slice('--timeout='.length)
      i++
    } else if (arg === '--prompt') {
      if (i + 1 >= args.length) return { error: die('tm send: --prompt requires a value') }
      prompt = args[i + 1]!
      hasPrompt = true
      i += 2
    } else if (arg.startsWith('--prompt=')) {
      prompt = arg.slice('--prompt='.length)
      hasPrompt = true
      i++
    } else if (arg === '--') {
      i++
      repo = args[i] ?? ''
      i++
      break
    } else if (arg.startsWith('-')) {
      return { error: die(`tm send: unknown flag: ${arg}`) }
    } else if (repo === '') {
      repo = arg
      i++
    } else {
      // Legacy form: `tm send <repo> <free text>`. Echo the whole remaining
      // argv so the suggested rewrite preserves every token. The escape uses
      // POSIX-safe shell single-quoting (no `printf %q` portable equivalent).
      const tail = args.slice(i).join(' ')
      return {
        error: die(
          'tm send: prompt is now a --prompt flag, not a positional arg. ' +
            `Did you mean: tm send ${repo} --prompt ${shellSingleQuote(tail)} ?`,
        ),
      }
    }
  }
  return { repo, prompt, hasPrompt, noWait, paneQuiet, timeout }
}

/**
 * `tm send` — atomic round-trip by default: send a prompt, block on the
 * Stop hook (or pane-quiet fallback), print the reply to stdout. The
 * stdout/stderr split is load-bearing for piping: status lines (the "sent
 * to ..." preamble, the post-turn ctx echo) ride stderr exclusively.
 */
const send: NativeVerb = async (args, _options, env) => {
  const parsed = parseSendArgs(args)
  if ('error' in parsed) return parsed.error
  const { repo, prompt, hasPrompt, noWait, paneQuiet, timeout } = parsed
  if (repo === '') {
    return die(
      'tm send: missing <repo>. Usage: tm send <repo> --prompt "..." [--no-wait] ' +
        '[--pane-quiet] [--timeout N]',
    )
  }
  if (!hasPrompt) {
    return die(
      'tm send: missing --prompt. Usage: tm send <repo> --prompt "..." [--no-wait] ' +
        '[--pane-quiet] [--timeout N]',
    )
  }
  if (!isNonNegativeInteger(timeout)) {
    return die(`tm send: --timeout must be a non-negative integer (got: '${timeout}')`)
  }

  const sentResult = await sendKeys(repo, prompt, env)
  if (sentResult.code !== 0) return sentResult

  if (noWait) return sentResult

  const timeoutSec = Number(timeout)
  const verdict = paneQuiet
    ? await waitPaneQuiet(repo, timeoutSec, env)
    : await waitIdleSignal(repo, timeoutSec, false, env)
  if ('code' in verdict) return verdict
  if (!verdict.ok) {
    const kind = paneQuiet ? 'pane-quiet' : 'Stop hook'
    return {
      code: 1,
      stdout: printLastOrEmpty(repo),
      stderr: sentResult.stderr + `tm send: timed out after ${timeout}s waiting for ${kind} on ${repo}\n`,
    }
  }

  let trailingStderr = ''
  if (!paneQuiet) trailingStderr = echoCtxToStderr(repo, env)
  return {
    code: 0,
    stdout: printLastOrEmpty(repo),
    stderr: sentResult.stderr + trailingStderr,
  }
}

// --- wait -----------------------------------------------------------------

/** Parsed arg vector for `tm wait`, after `parseWaitArgs`. */
interface WaitArgs {
  repo: string
  timeout: string
  fresh: boolean
  paneQuiet: boolean
}

/**
 * `cmd_wait`'s arg loop; positional after `<repo>` is a positional timeout.
 * `--timeout` with no value is bash's silent-exit-1 case (`${2:-}; shift 2`
 * trips `set -e`); mirror it so the conformance differential stays clean.
 */
function parseWaitArgs(args: readonly string[]): WaitArgs | { error: TmResult } {
  const SILENT: TmResult = { code: 1, stdout: '', stderr: '' }
  let repo = ''
  let timeout = '1800'
  let fresh = false
  let paneQuiet = false
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--fresh') {
      fresh = true
      i++
    } else if (arg === '--pane-quiet') {
      paneQuiet = true
      i++
    } else if (arg === '--timeout') {
      if (i + 1 >= args.length) return { error: SILENT }
      timeout = args[i + 1]!
      i += 2
    } else if (arg.startsWith('--timeout=')) {
      timeout = arg.slice('--timeout='.length)
      i++
    } else if (arg.startsWith('-')) {
      return { error: die(`tm wait: unknown flag: ${arg}`) }
    } else if (repo === '') {
      repo = arg
      i++
    } else {
      timeout = arg
      i++
    }
  }
  return { repo, timeout, fresh, paneQuiet }
}

/**
 * `tm wait` — block on the Stop-hook idle marker (default) or pane-quiet
 * fallback, then print the teammate's reply. Same output contract as
 * `tm send`. `--fresh` clears the baseline up front so it is the *next*
 * Stop that wakes the wait, not a prior one.
 */
const wait: NativeVerb = async (args, _options, env) => {
  const parsed = parseWaitArgs(args)
  if ('error' in parsed) return parsed.error
  const { repo, timeout, fresh, paneQuiet } = parsed
  if (repo === '') {
    return die(
      'usage: tm wait <repo> [timeout=1800] [--fresh] [--pane-quiet] [--timeout N]',
    )
  }
  if (!isNonNegativeInteger(timeout)) {
    return die(`tm wait: --timeout must be a non-negative integer (got: '${timeout}')`)
  }

  const timeoutSec = Number(timeout)
  const verdict = paneQuiet
    ? await waitPaneQuiet(repo, timeoutSec, env)
    : await waitIdleSignal(repo, timeoutSec, fresh, env)
  if ('code' in verdict) return verdict
  if (!verdict.ok) {
    return {
      code: 1,
      stdout: printLastOrEmpty(repo),
      stderr: `tm wait: timed out after ${timeout}s on ${repo}\n`,
    }
  }

  let trailingStderr = ''
  if (!paneQuiet) trailingStderr = echoCtxToStderr(repo, env)
  return {
    code: 0,
    stdout: printLastOrEmpty(repo),
    stderr: trailingStderr,
  }
}

// --- compact --------------------------------------------------------------

/** Parsed arg vector for `tm compact`, after `parseCompactArgs`. */
interface CompactArgs {
  repo: string
  timeout: string
}

/**
 * `cmd_compact`'s arg loop: same positional-then-flag rule as `wait`.
 * `--timeout` with no value is bash's silent-exit-1 case; mirror that.
 */
function parseCompactArgs(args: readonly string[]): CompactArgs | { error: TmResult } {
  const SILENT: TmResult = { code: 1, stdout: '', stderr: '' }
  let repo = ''
  let timeout = '1800'
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--timeout') {
      if (i + 1 >= args.length) return { error: SILENT }
      timeout = args[i + 1]!
      i += 2
    } else if (arg.startsWith('--timeout=')) {
      timeout = arg.slice('--timeout='.length)
      i++
    } else if (arg.startsWith('-')) {
      return { error: die(`tm compact: unknown flag: ${arg}`) }
    } else if (repo === '') {
      repo = arg
      i++
    } else {
      timeout = arg
      i++
    }
  }
  return { repo, timeout }
}

/** The visible pane line `cmd_compact` anchors its "too short" detection on. */
const COMPACT_REFUSAL_MARK = '⎿  Error: Not enough messages to compact'

/**
 * `tm compact` — send `/compact` and verify PostCompact fired. Reports the
 * one-line `compacted` on stdout when it did. Two failure modes, both exit 1:
 *
 * - Claude Code refuses with the "Not enough messages to compact" tool-result
 *   block. That path fires no Stop/PostCompact hook, so the visible pane is
 *   scanned alongside the idle-marker poll to detect it.
 * - PostCompact never fires within `--timeout` — compaction hung or the hook
 *   is misconfigured.
 */
const compact: NativeVerb = async (args, _options, env) => {
  const parsed = parseCompactArgs(args)
  if ('error' in parsed) return parsed.error
  const { repo, timeout } = parsed
  if (repo === '') return die('usage: tm compact <repo> [timeout=1800] [--timeout N]')
  if (!isNonNegativeInteger(timeout)) {
    return die(`tm compact: --timeout must be a non-negative integer (got: '${timeout}')`)
  }

  const sessionMissing = await requireSession(repo, env.runTmux)
  if (sessionMissing !== null) return sessionMissing
  const sidR = resolveSidOrDie(repo)
  if ('error' in sidR) return sidR.error
  const sid = sidR.sid
  const pane = await resolvePaneTarget(repo, env.runTmux)
  if (pane === '') return die(`could not resolve pane target for ${repo}`)

  let stderr = `tm compact: sending /compact to ${repo} (sid=${sid}, timeout=${timeout}s)\n`

  const sent = await sendKeys(repo, '/compact', env)
  // `bin/tm:1139` runs `_send_keys >/dev/null`, redirecting *stdout* only;
  // the `sent to ...` / `sid=...` lines `_send_keys` writes to stderr reach
  // the user. Preserve them by carrying `sent.stderr` on every return path.
  stderr += sent.stderr
  if (sent.code !== 0) {
    return { code: sent.code, stdout: sent.stdout, stderr }
  }

  const timeoutSec = Number(timeout)
  const end = nowSec() + timeoutSec
  const marker = idleMarkerFor(sid)
  while (nowSec() < end) {
    if (existsSync(marker)) {
      return { code: 0, stdout: 'compacted\n', stderr }
    }
    // `bin/tm`'s refusal scan is `[[ -n "$pane" ]] && tmux capture-pane ...`
    // — if the pane is gone the verb silently disables refusal detection and
    // keeps polling the idle marker. Mirror that.
    if (pane.length > 0) {
      try {
        const captured = await env.runTmux(['capture-pane', '-t', pane, '-p'])
        if (captured.code === 0 && captured.stdout.includes(COMPACT_REFUSAL_MARK)) {
          return {
            code: 1,
            stdout: '',
            stderr:
              stderr +
              `tm compact: ${repo} refused /compact — Claude Code reported ` +
              "'Not enough messages to compact' (transcript too short).\n",
          }
        }
      } catch {
        // A capture failure is a transient tmux error; the idle marker is
        // the primary signal — keep polling.
      }
    }
    await sleepMs(3000)
  }
  return {
    code: 1,
    stdout: '',
    stderr:
      stderr +
      `tm compact: ${repo} did not signal PostCompact within ${timeout}s — ` +
      "compaction may still be running, or the Stop hook is misconfigured. " +
      `Check 'tm status ${repo}' and ${marker}.\n`,
  }
}

// --- resume ---------------------------------------------------------------

/** Parsed arg vector for `tm resume`, after `parseResumeArgs`. */
interface ResumeArgs {
  repo: string
  sid: string
  task: string
  prompt: string
  hasPrompt: boolean
  noWait: boolean
}

/**
 * `cmd_resume`'s arg loop; two positionals (`<repo> [<sid>]`) plus flags.
 * Like `cmd_spawn`, `--task` is bash's silent-exit-1 path (no `[[ $# -ge 2 ]]`
 * guard); `--prompt` is the explicit-die path.
 */
function parseResumeArgs(args: readonly string[]): ResumeArgs | { error: TmResult } {
  const SILENT: TmResult = { code: 1, stdout: '', stderr: '' }
  let repo = ''
  let sid = ''
  let task = ''
  let prompt = ''
  let hasPrompt = false
  let noWait = false
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--prompt') {
      if (i + 1 >= args.length) return { error: die('tm resume: --prompt requires a value') }
      prompt = args[i + 1]!
      hasPrompt = true
      i += 2
    } else if (arg.startsWith('--prompt=')) {
      prompt = arg.slice('--prompt='.length)
      hasPrompt = true
      i++
    } else if (arg === '--task') {
      if (i + 1 >= args.length) return { error: SILENT }
      task = args[i + 1]!
      i += 2
    } else if (arg.startsWith('--task=')) {
      task = arg.slice('--task='.length)
      i++
    } else if (arg === '--no-wait') {
      noWait = true
      i++
    } else if (arg === '--') {
      i++
      break
    } else if (arg.startsWith('-')) {
      return { error: die(`unknown flag: ${arg}`) }
    } else if (repo === '') {
      repo = arg
      i++
    } else if (sid === '') {
      sid = arg
      i++
    } else {
      return {
        error: die(
          `tm resume: too many positional args (got '${arg}' after ` +
            `repo='${repo}' sid='${sid}')`,
        ),
      }
    }
  }
  return { repo, sid, task, prompt, hasPrompt, noWait }
}

/** A UUID — the format `tm resume` requires for a resolved sid. */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * `tm resume` — relaunch a prior conversation. With no sid the verb falls
 * back to "newest jsonl by mtime" (a stderr warning prompts the caller to
 * pass an explicit sid from the dispatcher's task ledger). With a sid it
 * proves the transcript exists, then delegates to `spawn --resume`.
 */
const resume: NativeVerb = async (args, _options, env) => {
  const parsed = parseResumeArgs(args)
  if ('error' in parsed) return parsed.error
  let { sid } = parsed
  const { repo, task, prompt, hasPrompt, noWait } = parsed
  if (repo === '') {
    return die(
      'usage: tm resume <repo> [<sid>] [--task <slug>] [--prompt "..."] [--no-wait]  ' +
        '(sid from ledger preferred; auto-pick on omit; --task relabels the resumed ' +
        'conversation; --no-wait only with --prompt)',
    )
  }
  if (noWait && !hasPrompt) {
    return die('tm resume: --no-wait is only valid with --prompt')
  }

  const path = join(env.dispatcherDir, repo)
  if (!isDirectory(path)) return dieRepoNotFound('resume', repo, path, env.dispatcherDir)

  const name = `${SESSION_PREFIX}${repo}`
  if (await sessionExists(name, env.runTmux)) {
    return die(
      `${repo} already running (tmux=${name}) — 'tm kill ${repo}' first ` +
        'if you really want to start over',
    )
  }

  const projectDir = projectDirForRepo(repo, env)
  let autoPickStderr = ''

  if (sid === '') {
    if (!isDirectory(projectDir)) {
      return die(
        `no project dir at ${projectDir} — has anyone ever run claude inside ` +
          `${path}? Try 'tm spawn ${repo}' first.`,
      )
    }
    let names: string[] = []
    try {
      names = readdirSync(projectDir).filter((file) => file.endsWith('.jsonl'))
    } catch {
      names = []
    }
    if (names.length === 0) {
      return die(`no .jsonl transcripts under ${projectDir} — try 'tm spawn ${repo}' to start fresh.`)
    }
    const stats = names.map((file) => {
      let mtime = 0
      try {
        mtime = Math.floor(statSync(join(projectDir, file)).mtimeMs / 1000)
      } catch {
        mtime = 0
      }
      return { file, mtime }
    })
    stats.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    const latest = stats[0]!
    sid = latest.file.replace(/\.jsonl$/, '')
    autoPickStderr =
      `tm resume: no sid given — auto-picked ${sid} (jsonl mtime ` +
      `${fmtLocalDateTime(latest.mtime)}). Prefer passing the sid from your task ledger.\n`
  } else {
    const target = join(projectDir, `${sid}.jsonl`)
    if (!isRegularFile(target)) {
      return die(
        `no transcript at ${target} — wrong repo for this sid, or sid does not ` +
          `exist. Check 'ls ${projectDir}/'.`,
      )
    }
  }

  if (!UUID_RE.test(sid)) return die(`sid is not a valid uuid: ${sid}`)

  // Delegate the rest of the launch to `spawn` via its `--resume` path. This
  // mirrors `cmd_resume`'s `cmd_spawn` recursion: the launch flags and the
  // optional `--prompt` follow-up are spawn's concern, not resume's.
  const spawnArgs: string[] = [repo, '--resume', sid]
  if (task.length > 0) {
    spawnArgs.push('--task', task)
  }
  if (hasPrompt) {
    if (noWait) spawnArgs.push('--no-wait')
    spawnArgs.push('--prompt', prompt)
  }
  const result = await spawn(spawnArgs, undefined, env)
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: autoPickStderr + result.stderr,
  }
}

/** Every natively-migrated verb, keyed by verb name. */
export const NATIVE_VERBS: Readonly<Record<string, NativeVerb>> = {
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
  spawn,
  send,
  wait,
  compact,
  resume,
}

/** Whether `core.ts` should run this verb natively rather than shelling out. */
export function isNativeVerb(name: string): boolean {
  return Object.hasOwn(NATIVE_VERBS, name)
}
