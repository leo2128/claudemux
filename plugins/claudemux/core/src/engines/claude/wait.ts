/**
 * `tm wait` — block on the Stop-hook idle marker (default) or pane-
 * quiet fallback, then print the teammate's reply. Same output contract
 * as `tm send`. `--fresh` clears the baseline up front so it is the
 * *next* Stop that wakes the wait, not a prior one.
 */

import { waitIdleSignal, waitPaneQuiet } from './wait-signals'
import { echoCtxToStderr, printLastOrEmpty } from './post-turn'
import { die } from './tmux'
import { isNonNegativeInteger } from './clock'
import type { ClaudeVerbEnv } from './env'
import type { TmResult } from '../../tm'

/** Parsed arg vector for `tm wait`. */
export interface WaitArgs {
  repo: string
  timeout: string
  fresh: boolean
  paneQuiet: boolean
}

/**
 * `cmd_wait`'s arg loop; positional after `<repo>` is a positional
 * timeout. `--timeout` with no value is bash's silent-exit-1 case
 * (`${2:-}; shift 2` trips `set -e`); mirror it so the conformance
 * differential stays clean.
 */
export function parseWaitArgs(args: readonly string[]): WaitArgs | { error: TmResult } {
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

export async function claudeWait(args: readonly string[], env: ClaudeVerbEnv): Promise<TmResult> {
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
    ? await waitPaneQuiet(repo, timeoutSec, env.runTmux)
    : await waitIdleSignal(repo, timeoutSec, fresh, env.runTmux)
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
