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
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { dirname, join } from 'node:path'

import {
  busyMarkerFor,
  cwdFile,
  encodeProjectDir,
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

  const end = Math.floor(Date.now() / 1000) + bashNum(timeoutArg)
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
 * Argument parsing and the repo fan-out are native; each teammate's send is
 * delegated to a `tm send` subprocess, because `send` is not yet migrated.
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
    let sent: TmResult
    try {
      sent = await env.runTm('send', ['--no-wait', repo, '--prompt', '/reload-plugins'])
    } catch {
      // A `tm send` that cannot even start is the same as a non-zero exit.
      sent = { code: 1, stdout: '', stderr: '' }
    }
    // A non-zero `tm send` is the `_send_keys` `die` that ends `tm reload`;
    // its own stderr went to `cmd_reload`'s `>/dev/null`, so it is dropped.
    if (sent.code !== 0) return { code: sent.code, stdout, stderr: '' }
  }
  return { code: 0, stdout, stderr: '' }
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
}

/** Whether `core.ts` should run this verb natively rather than shelling out. */
export function isNativeVerb(name: string): boolean {
  return Object.hasOwn(NATIVE_VERBS, name)
}
