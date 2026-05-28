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
import { parseWaitArgs } from '../../shared/verb-args'
import type { ClaudeVerbEnv } from './env'
import { EXIT_SYNC_WAIT_EXPIRED, type TmResult } from '../../tm'

export async function claudeWait(args: readonly string[], env: ClaudeVerbEnv): Promise<TmResult> {
  const parsed = parseWaitArgs(args)
  if ('error' in parsed) return parsed.error
  const { name, timeout, fresh, paneQuiet } = parsed
  if (name === '') {
    return die(
      'usage: tm wait <name> [timeout=1800] [--fresh] [--pane-quiet] [--timeout N]',
    )
  }
  if (timeout !== null && !isNonNegativeInteger(timeout)) {
    return die(`tm wait: --timeout must be a non-negative integer (got: '${timeout}')`)
  }

  const timeoutSec = timeout === null ? 1800 : Number(timeout)
  const verdict = paneQuiet
    ? await waitPaneQuiet(name, timeoutSec, env.runTmux)
    : await waitIdleSignal(name, timeoutSec, fresh, env.runTmux)
  if ('code' in verdict) return verdict
  if (!verdict.ok) {
    // See `send.ts` for the rationale — re-probe before promising "still
    // running" (124) so a teammate that died mid-wait surfaces as a real
    // failure (exit 1) instead of being kept on the dispatcher's "keep
    // tailing" list forever.
    const dead = await probeStillAlive(name, env.runTmux)
    if (dead !== null) return dead
    const kind = paneQuiet ? 'pane-quiet' : 'Stop hook'
    return {
      code: EXIT_SYNC_WAIT_EXPIRED,
      stdout: printLastOrEmpty(name),
      stderr:
        `tm wait: sync wait expired after ${timeoutSec}s on ${name} ` +
        `(no ${kind} fired; the teammate is still running — re-run ` +
        `'tm wait ${name}' or check 'tm status ${name}'). exit ${EXIT_SYNC_WAIT_EXPIRED}.\n`,
    }
  }

  let trailingStderr = ''
  if (!paneQuiet) trailingStderr = echoCtxToStderr(name, env)
  return {
    code: 0,
    stdout: printLastOrEmpty(name),
    stderr: trailingStderr,
  }
}
