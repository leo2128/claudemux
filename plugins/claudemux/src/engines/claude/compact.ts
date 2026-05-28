/**
 * `tm compact` — send `/compact` and verify PostCompact fired. Reports
 * the one-line `compacted` on stdout when it did. Two non-success modes
 * with different exit codes:
 *
 *   - Claude Code refuses with the "Not enough messages to compact"
 *     tool-result block. That path fires no Stop/PostCompact hook, so
 *     the visible pane is scanned alongside the idle-marker poll to
 *     detect it. Exit 1 — `/compact` rejected and won't proceed.
 *   - PostCompact never fires within `--timeout` — compaction may still
 *     be running. Exit `EXIT_SYNC_WAIT_EXPIRED` (124) to mark this as
 *     "sync wait expired, teammate still running", distinct from a true
 *     failure (no session, sid missing) which keeps exit 1.
 */

import { existsSync } from 'node:fs'

import { sendKeys } from './keys'
import { resolveSidOrDie } from './idle'
import { idleMarkerFor } from '../../persistence/paths'
import { die, requireSession, resolvePaneTarget } from './tmux'
import { isNonNegativeInteger, nowSec, sleepMs } from './clock'
import { probeStillAlive } from './wait-signals'
import { parseCompactArgs } from '../../shared/verb-args'
import type { ClaudeVerbEnv } from './env'
import { EXIT_SYNC_WAIT_EXPIRED, type TmResult } from '../../tm'

/** The bracketed-paste refusal `Claude Code` emits for a too-short transcript. */
export const COMPACT_REFUSAL_MARK = '⎿  Error: Not enough messages to compact'

export async function claudeCompact(args: readonly string[], env: ClaudeVerbEnv): Promise<TmResult> {
  const parsed = parseCompactArgs(args)
  if ('error' in parsed) return parsed.error
  const { name, timeout } = parsed
  if (name === '') return die('usage: tm compact <name> [timeout=1800] [--timeout N]')
  if (!isNonNegativeInteger(timeout)) {
    return die(`tm compact: --timeout must be a non-negative integer (got: '${timeout}')`)
  }

  const sessionMissing = await requireSession(name, env.runTmux)
  if (sessionMissing !== null) return sessionMissing
  const sidR = resolveSidOrDie(name)
  if ('error' in sidR) return sidR.error
  const sid = sidR.sid
  const pane = await resolvePaneTarget(name, env.runTmux)
  if (pane === '') return die(`could not resolve pane target for ${name}`)

  let stderr = `tm compact: sending /compact to ${name} (sid=${sid}, timeout=${timeout}s)\n`

  const sent = await sendKeys(name, '/compact', env.runTmux, process.env)
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
    // — if the pane is gone the verb silently disables refusal detection
    // and keeps polling the idle marker. Mirror that.
    if (pane.length > 0) {
      try {
        const captured = await env.runTmux(['capture-pane', '-t', pane, '-p'])
        if (captured.code === 0 && captured.stdout.includes(COMPACT_REFUSAL_MARK)) {
          return {
            code: 1,
            stdout: '',
            stderr:
              stderr +
              `tm compact: ${name} refused /compact — Claude Code reported ` +
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
  // Same re-probe pattern as `send.ts` / `wait.ts`: 124 means "still
  // running, compact may yet finish — re-collect with `tm wait`." If the
  // tmux session or sid file vanished mid-wait, that promise is false and
  // returning 124 would deadlock the dispatcher into never respawning.
  const dead = await probeStillAlive(name, env.runTmux)
  if (dead !== null) {
    return { ...dead, stderr: stderr + dead.stderr }
  }
  return {
    code: EXIT_SYNC_WAIT_EXPIRED,
    stdout: '',
    stderr:
      stderr +
      `tm compact: sync wait expired after ${timeout}s on ${name} ` +
      '(PostCompact never fired; compaction may still be running, or the ' +
      `Stop hook is misconfigured). Check 'tm status ${name}' and ${marker}. ` +
      `exit ${EXIT_SYNC_WAIT_EXPIRED}.\n`,
  }
}
