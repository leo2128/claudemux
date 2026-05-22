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
 * Migrated so far: `ls`, `last`, `ctx`.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { cwdFile, encodeProjectDir, lastFileFor, sidFile } from './paths'
import type { TmResult, TmRunOptions } from './tm'
import type { TmuxRunner } from './tmux'

/** The teammate session-name prefix — `tm`'s `PREFIX`, mirrored here. */
const SESSION_PREFIX = 'teammate-'

/** Everything a native verb may need beyond its arguments; injectable for tests. */
export interface NativeEnv {
  /** Runs `tmux` — injected so a conformance fixture can supply a fake. */
  runTmux: TmuxRunner
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

/** Every natively-migrated verb, keyed by verb name. */
export const NATIVE_VERBS: Readonly<Record<string, NativeVerb>> = { ls, last, ctx }

/** Whether `core.ts` should run this verb natively rather than shelling out. */
export function isNativeVerb(name: string): boolean {
  return Object.hasOwn(NATIVE_VERBS, name)
}
