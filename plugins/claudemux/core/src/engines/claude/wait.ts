/**
 * `tm wait` — block on the Stop-hook idle marker (default) or pane-
 * quiet fallback, then print the teammate's reply. Same output contract
 * as `tm send`. `--fresh` clears the baseline up front so it is the
 * *next* Stop that wakes the wait, not a prior one.
 */

import { probeStillAlive, waitIdleSignal, waitPaneQuiet } from './wait-signals'
import { echoCtxToStderr, printLastOrEmpty } from './post-turn'
import { die } from './tmux'
import { isNonNegativeInteger } from './clock'
import type { ClaudeVerbEnv } from './env'
import { EXIT_SYNC_WAIT_EXPIRED, type TmResult } from '../../tm'

/** Parsed arg vector for `tm wait`. */
export interface WaitArgs {
  repo: string
  timeout: string | null
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
  if (timeout !== null && !isNonNegativeInteger(timeout)) {
    return die(`tm wait: --timeout must be a non-negative integer (got: '${timeout}')`)
  }

  const timeoutSec = timeout === null ? 1800 : Number(timeout)
  const verdict = paneQuiet
    ? await waitPaneQuiet(repo, timeoutSec, env.runTmux)
    : await waitIdleSignal(repo, timeoutSec, fresh, env.runTmux)
  if ('code' in verdict) return verdict
  if (!verdict.ok) {
    // See `send.ts` for the rationale — re-probe before promising "still
    // running" (124) so a teammate that died mid-wait surfaces as a real
    // failure (exit 1) instead of being kept on the dispatcher's "keep
    // tailing" list forever.
    const dead = await probeStillAlive(repo, env.runTmux)
    if (dead !== null) return dead
    const kind = paneQuiet ? 'pane-quiet' : 'Stop hook'
    return {
      code: EXIT_SYNC_WAIT_EXPIRED,
      stdout: printLastOrEmpty(repo),
      stderr:
        `tm wait: sync wait expired after ${timeoutSec}s on ${repo} ` +
        `(no ${kind} fired; the teammate is still running — re-run ` +
        `'tm wait ${repo}' or check 'tm status ${repo}'). exit ${EXIT_SYNC_WAIT_EXPIRED}.\n`,
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
