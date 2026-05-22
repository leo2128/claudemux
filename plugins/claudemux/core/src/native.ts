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
 * Migrated so far: `ls`, `last`.
 */

import { readFileSync, statSync } from 'node:fs'

import { lastFileFor, sidFile } from './paths'
import type { TmResult, TmRunOptions } from './tm'
import type { TmuxRunner } from './tmux'

/** The teammate session-name prefix — `tm`'s `PREFIX`, mirrored here. */
const SESSION_PREFIX = 'teammate-'

/** Everything a native verb may need beyond its arguments; injectable for tests. */
export interface NativeEnv {
  /** Runs `tmux` — injected so a conformance fixture can supply a fake. */
  runTmux: TmuxRunner
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

/** Every natively-migrated verb, keyed by verb name. */
export const NATIVE_VERBS: Readonly<Record<string, NativeVerb>> = { ls, last }

/** Whether `core.ts` should run this verb natively rather than shelling out. */
export function isNativeVerb(name: string): boolean {
  return Object.hasOwn(NATIVE_VERBS, name)
}
