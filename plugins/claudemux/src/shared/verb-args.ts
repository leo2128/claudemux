/**
 * Shared CLI argument parsers for teammate verbs.
 *
 * These parsers sit outside any concrete engine because `tm spawn` and
 * `tm resume` carry cross-engine flags (`--engine`) even when the eventual
 * request is routed to Claude or Codex. Keeping them here prevents the CLI
 * layer from importing parser helpers out of `engines/claude/`.
 */

import type { TmResult } from '../tm'

type EngineFlag = 'claude' | 'codex'

function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

/** Parsed arg vector for `tm compact`. */
export interface CompactArgs {
  name: string
  timeout: string
}

/** Parsed arg vector for `tm resume`. */
export interface ResumeArgs {
  name: string
  sid: string
  prompt: string
  hasPrompt: boolean
  engine: EngineFlag | null
}

/** Parsed arg vector for `tm send`. */
export interface SendArgs {
  name: string
  prompt: string
  hasPrompt: boolean
  paneQuiet: boolean
  timeout: string | null
}

/** Parsed arg vector for `tm spawn`. */
export interface SpawnArgs {
  engine: EngineFlag | null
  /** Explicit teammate name from `--name`; empty when the caller wants auto-gen. */
  name: string
  resumeSid: string
  prompt: string
  hasPrompt: boolean
  timeout: string | null
  noWorktree: boolean
}

/** Parsed arg vector for `tm wait`. */
export interface WaitArgs {
  name: string
  timeout: string | null
  fresh: boolean
  paneQuiet: boolean
}

/**
 * `tm compact`'s arg loop: same positional-then-flag rule as `wait`.
 * `--timeout` with no value is the bash silent-exit-1 case; mirror it.
 */
export function parseCompactArgs(args: readonly string[]): CompactArgs | { error: TmResult } {
  const SILENT: TmResult = { code: 1, stdout: '', stderr: '' }
  let name = ''
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
    } else if (name === '') {
      name = arg
      i++
    } else {
      timeout = arg
      i++
    }
  }
  return { name, timeout }
}

/**
 * `tm resume`'s arg loop; two positionals (`<name> [<sid>]`) plus
 * flags. `--prompt` and `--engine` carry required values; missing
 * values surface as explicit errors.
 */
export function parseResumeArgs(args: readonly string[]): ResumeArgs | { error: TmResult } {
  let name = ''
  let sid = ''
  let prompt = ''
  let hasPrompt = false
  let engine: EngineFlag | null = null
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
    } else if (arg === '--engine') {
      if (i + 1 >= args.length) return { error: die('tm resume: --engine requires a value') }
      const value = args[i + 1]!
      if (value !== 'claude' && value !== 'codex') {
        return { error: die(`tm resume: --engine must be 'claude' or 'codex' (got: '${value}')`) }
      }
      engine = value
      i += 2
    } else if (arg.startsWith('--engine=')) {
      const value = arg.slice('--engine='.length)
      if (value !== 'claude' && value !== 'codex') {
        return { error: die(`tm resume: --engine must be 'claude' or 'codex' (got: '${value}')`) }
      }
      engine = value
      i++
    } else if (arg === '--') {
      i++
      break
    } else if (arg.startsWith('-')) {
      return { error: die(`unknown flag: ${arg}`) }
    } else if (name === '') {
      name = arg
      i++
    } else if (sid === '') {
      sid = arg
      i++
    } else {
      return {
        error: die(
          `tm resume: too many positional args (got '${arg}' after ` +
            `name='${name}' sid='${sid}')`,
        ),
      }
    }
  }
  return { name, sid, prompt, hasPrompt, engine }
}

/**
 * Single-quote-escape a string for safe embedding in a bash command
 * line — used by the legacy-form error suggestion below.
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * `tm send`'s arg loop. Catches the legacy `tm send <name> <free
 * text>` form with a dedicated error — pre-0.3.0 callers passed
 * prompts as positional args, and this catches that habit explicitly
 * rather than swallowing the trailing positionals as a confusing
 * "unknown arg".
 */
export function parseSendArgs(args: readonly string[]): SendArgs | { error: TmResult } {
  let paneQuiet = false
  let timeout: string | null = null
  let name = ''
  let prompt = ''
  let hasPrompt = false
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--pane-quiet') {
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
      name = args[i] ?? ''
      i++
      break
    } else if (arg.startsWith('-')) {
      return { error: die(`tm send: unknown flag: ${arg}`) }
    } else if (name === '') {
      name = arg
      i++
    } else {
      const tail = args.slice(i).join(' ')
      return {
        error: die(
          'tm send: prompt is now a --prompt flag, not a positional arg. ' +
            `Did you mean: tm send ${name} --prompt ${shellSingleQuote(tail)} ?`,
        ),
      }
    }
  }
  return { name, prompt, hasPrompt, paneQuiet, timeout }
}

/**
 * `tm spawn`'s arg loop. `--prompt` and `--name` carry required
 * values; `--resume <sid>` and `--timeout` accept either a separate
 * value or `--flag=value` form. `--no-worktree` is a boolean.
 *
 * `--task` was removed in the schema-2 cut — pass `--name` instead.
 */
export function parseSpawnArgs(rest: readonly string[]): SpawnArgs | { error: TmResult } {
  const SILENT: TmResult = { code: 1, stdout: '', stderr: '' }
  let name = ''
  let resumeSid = ''
  let prompt = ''
  let hasPrompt = false
  let timeout: string | null = null
  let engine: EngineFlag | null = null
  let noWorktree = false
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!
    if (arg === '--resume') {
      if (i + 1 >= rest.length) return { error: SILENT }
      resumeSid = rest[i + 1]!
      i++
    } else if (arg === '--engine') {
      if (i + 1 >= rest.length) return { error: die('tm spawn: --engine requires a value') }
      const value = rest[i + 1]!
      if (value !== 'claude' && value !== 'codex') {
        return { error: die(`tm spawn: --engine must be 'claude' or 'codex' (got: '${value}')`) }
      }
      engine = value
      i++
    } else if (arg.startsWith('--engine=')) {
      const value = arg.slice('--engine='.length)
      if (value !== 'claude' && value !== 'codex') {
        return { error: die(`tm spawn: --engine must be 'claude' or 'codex' (got: '${value}')`) }
      }
      engine = value
    } else if (arg === '--name') {
      if (i + 1 >= rest.length) return { error: die('tm spawn: --name requires a value') }
      name = rest[i + 1]!
      i++
    } else if (arg.startsWith('--name=')) {
      name = arg.slice('--name='.length)
    } else if (arg === '--task' || arg.startsWith('--task=')) {
      return {
        error: die(
          "tm spawn: --task was removed in the name/repo decoupling cut. " +
            "Pass --name <id> to set an explicit teammate name, or omit it " +
            'to auto-generate (`<path-leaf>-<rand4>`).',
        ),
      }
    } else if (arg === '--timeout') {
      if (i + 1 >= rest.length) return { error: die('tm spawn: --timeout requires a value') }
      timeout = rest[i + 1]!
      i++
    } else if (arg.startsWith('--timeout=')) {
      timeout = arg.slice('--timeout='.length)
    } else if (arg === '--prompt') {
      if (i + 1 >= rest.length) return { error: die('tm spawn: --prompt requires a value') }
      prompt = rest[i + 1]!
      hasPrompt = true
      i++
    } else if (arg.startsWith('--prompt=')) {
      prompt = arg.slice('--prompt='.length)
      hasPrompt = true
    } else if (arg === '--no-worktree') {
      noWorktree = true
    } else {
      return { error: die(`unknown flag: ${arg}`) }
    }
  }
  return { engine, name, resumeSid, prompt, hasPrompt, timeout, noWorktree }
}

/**
 * `tm wait`'s arg loop; positional after `<name>` is a positional
 * timeout. `--timeout` with no value is the bash silent-exit-1 case;
 * mirror it so the conformance differential stays clean.
 */
export function parseWaitArgs(args: readonly string[]): WaitArgs | { error: TmResult } {
  const SILENT: TmResult = { code: 1, stdout: '', stderr: '' }
  let name = ''
  let timeout: string | null = null
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
    } else if (name === '') {
      name = arg
      i++
    } else {
      timeout = arg
      i++
    }
  }
  return { name, timeout, fresh, paneQuiet }
}
