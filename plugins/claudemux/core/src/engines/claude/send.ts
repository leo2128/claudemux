/**
 * `tm send` — atomic round-trip by default: send a prompt, block on the
 * Stop hook (or pane-quiet fallback), print the reply to stdout.
 *
 * The stdout/stderr split is load-bearing for piping: status lines
 * (the "sent to ..." preamble, the post-turn ctx echo) ride stderr
 * exclusively.
 *
 * Two exported entry points keep the strangler clean:
 *   - `claudeSend(args, env)` — byte-exact `TmResult`, the cli dispatch
 *     and the conformance harness both pin to this shape.
 *   - `parseSendArgs` is reused by `claudeReload` (which fans out by
 *     calling `claudeSend` directly).
 */

import { sendKeys } from './keys'
import { waitIdleSignal, waitPaneQuiet } from './wait-signals'
import { echoCtxToStderr, printLastOrEmpty } from './post-turn'
import { die } from './tmux'
import { isNonNegativeInteger } from './clock'
import type { ClaudeVerbEnv } from './env'
import type { TmResult } from '../../tm'

/** Parsed arg vector for `tm send`. */
export interface SendArgs {
  repo: string
  prompt: string
  hasPrompt: boolean
  paneQuiet: boolean
  timeout: string | null
}

/**
 * Single-quote-escape a string for safe embedding in a bash command
 * line — used by the legacy-form error suggestion below.
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * `cmd_send`'s arg loop. Catches the legacy "tm send repo run tests"
 * form with a dedicated error — pre-0.3.0 callers passed prompts as
 * positional args, and this catches that habit explicitly rather than
 * swallowing the trailing positionals as a confusing "unknown arg".
 */
export function parseSendArgs(args: readonly string[]): SendArgs | { error: TmResult } {
  let paneQuiet = false
  let timeout: string | null = null
  let repo = ''
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
      // argv so the suggested rewrite preserves every token. The escape
      // uses POSIX-safe shell single-quoting.
      const tail = args.slice(i).join(' ')
      return {
        error: die(
          'tm send: prompt is now a --prompt flag, not a positional arg. ' +
            `Did you mean: tm send ${repo} --prompt ${shellSingleQuote(tail)} ?`,
        ),
      }
    }
  }
  return { repo, prompt, hasPrompt, paneQuiet, timeout }
}

/**
 * The Claude-side `tm send` body. The wrapper at the CLI layer handles
 * the codex fork; this function is Claude-only.
 */
export async function claudeSend(args: readonly string[], env: ClaudeVerbEnv): Promise<TmResult> {
  const parsed = parseSendArgs(args)
  if ('error' in parsed) return parsed.error
  const { repo, prompt, hasPrompt, paneQuiet, timeout } = parsed
  if (repo === '') {
    return die(
      'tm send: missing <repo>. Usage: tm send <repo> --prompt "..." ' +
        '[--pane-quiet] [--timeout N]',
    )
  }
  if (!hasPrompt) {
    return die(
      'tm send: missing --prompt. Usage: tm send <repo> --prompt "..." ' +
        '[--pane-quiet] [--timeout N]',
    )
  }
  if (timeout !== null && !isNonNegativeInteger(timeout)) {
    return die(`tm send: --timeout must be a non-negative integer (got: '${timeout}')`)
  }

  const sentResult = await sendKeys(repo, prompt, env.runTmux, process.env)
  if (sentResult.code !== 0) return sentResult

  const timeoutSec = timeout === null ? 1800 : Number(timeout)
  const verdict = paneQuiet
    ? await waitPaneQuiet(repo, timeoutSec, env.runTmux)
    : await waitIdleSignal(repo, timeoutSec, false, env.runTmux)
  if ('code' in verdict) return verdict
  if (!verdict.ok) {
    const kind = paneQuiet ? 'pane-quiet' : 'Stop hook'
    return {
      code: 1,
      stdout: printLastOrEmpty(repo),
      stderr:
        sentResult.stderr +
        `tm send: timed out after ${timeoutSec}s waiting for ${kind} on ${repo}\n`,
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
