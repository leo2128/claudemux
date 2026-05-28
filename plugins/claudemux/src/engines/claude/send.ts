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
 *   - the shared parser in `shared/verb-args.ts` is reused by `claudeReload`
 *     (which fans out by calling `claudeSend` directly).
 */

import { sendKeys } from './keys'
import { probeStillAlive, waitIdleSignal, waitPaneQuiet } from './wait-signals'
import { echoCtxToStderr, printLastOrEmpty } from './post-turn'
import { die } from './tmux'
import { isNonNegativeInteger } from './clock'
import { parseSendArgs } from '../../shared/verb-args'
import type { ClaudeVerbEnv } from './env'
import { EXIT_SYNC_WAIT_EXPIRED, type TmResult } from '../../tm'

/**
 * The Claude-side `tm send` body. The wrapper at the CLI layer handles
 * the codex fork; this function is Claude-only.
 */
export async function claudeSend(args: readonly string[], env: ClaudeVerbEnv): Promise<TmResult> {
  const parsed = parseSendArgs(args)
  if ('error' in parsed) return parsed.error
  const { name, prompt, hasPrompt, paneQuiet, timeout } = parsed
  if (name === '') {
    return die(
      'tm send: missing <name>. Usage: tm send <name> --prompt "..." ' +
        '[--pane-quiet] [--timeout N]',
    )
  }
  if (!hasPrompt) {
    return die(
      'tm send: missing --prompt. Usage: tm send <name> --prompt "..." ' +
        '[--pane-quiet] [--timeout N]',
    )
  }
  if (timeout !== null && !isNonNegativeInteger(timeout)) {
    return die(`tm send: --timeout must be a non-negative integer (got: '${timeout}')`)
  }

  const sentResult = await sendKeys(name, prompt, env.runTmux, process.env)
  if (sentResult.code !== 0) return sentResult

  const timeoutSec = timeout === null ? 1800 : Number(timeout)
  const verdict = paneQuiet
    ? await waitPaneQuiet(name, timeoutSec, env.runTmux)
    : await waitIdleSignal(name, timeoutSec, false, env.runTmux)
  if ('code' in verdict) return verdict
  if (!verdict.ok) {
    // Re-probe at the timeout moment: a teammate that died mid-wait must
    // NOT be reported as "still running" with code 124, or the dispatcher's
    // bg classifier will (correctly per the documented 124 contract)
    // decide not to respawn and silently wait forever on a corpse. Only
    // promise 124 ("still running") when the session + sid are still there.
    const dead = await probeStillAlive(name, env.runTmux)
    if (dead !== null) {
      return { ...dead, stderr: sentResult.stderr + dead.stderr }
    }
    const kind = paneQuiet ? 'pane-quiet' : 'Stop hook'
    return {
      code: EXIT_SYNC_WAIT_EXPIRED,
      stdout: printLastOrEmpty(name),
      stderr:
        sentResult.stderr +
        `tm send: sync wait expired after ${timeoutSec}s on ${name} ` +
        `(no ${kind} fired; the teammate is still running — tail with ` +
        `'tm wait ${name}' or check 'tm status ${name}'). exit ${EXIT_SYNC_WAIT_EXPIRED}.\n`,
    }
  }

  let trailingStderr = ''
  if (!paneQuiet) trailingStderr = echoCtxToStderr(name, env)
  return {
    code: 0,
    stdout: printLastOrEmpty(name),
    stderr: sentResult.stderr + trailingStderr,
  }
}
