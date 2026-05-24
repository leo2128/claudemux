/**
 * `tm compact` — send `/compact` and verify PostCompact fired. Reports
 * the one-line `compacted` on stdout when it did. Two failure modes,
 * both exit 1:
 *
 *   - Claude Code refuses with the "Not enough messages to compact"
 *     tool-result block. That path fires no Stop/PostCompact hook, so
 *     the visible pane is scanned alongside the idle-marker poll to
 *     detect it.
 *   - PostCompact never fires within `--timeout` — compaction hung or
 *     the hook is misconfigured.
 */

import { existsSync } from 'node:fs'

import { sendKeys } from './keys'
import { resolveSidOrDie } from './idle'
import { idleMarkerFor } from './persistence'
import { die, requireSession, resolvePaneTarget } from './tmux'
import { isNonNegativeInteger, nowSec, sleepMs } from './clock'
import type { ClaudeVerbEnv } from './env'
import type { TmResult } from '../../tm'

/** Parsed arg vector for `tm compact`. */
export interface CompactArgs {
  repo: string
  timeout: string
}

/**
 * `cmd_compact`'s arg loop: same positional-then-flag rule as `wait`.
 * `--timeout` with no value is bash's silent-exit-1 case; mirror that.
 */
export function parseCompactArgs(args: readonly string[]): CompactArgs | { error: TmResult } {
  const SILENT: TmResult = { code: 1, stdout: '', stderr: '' }
  let repo = ''
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
    } else if (repo === '') {
      repo = arg
      i++
    } else {
      timeout = arg
      i++
    }
  }
  return { repo, timeout }
}

/** The bracketed-paste refusal `Claude Code` emits for a too-short transcript. */
export const COMPACT_REFUSAL_MARK = '⎿  Error: Not enough messages to compact'

export async function claudeCompact(args: readonly string[], env: ClaudeVerbEnv): Promise<TmResult> {
  const parsed = parseCompactArgs(args)
  if ('error' in parsed) return parsed.error
  const { repo, timeout } = parsed
  if (repo === '') return die('usage: tm compact <repo> [timeout=1800] [--timeout N]')
  if (!isNonNegativeInteger(timeout)) {
    return die(`tm compact: --timeout must be a non-negative integer (got: '${timeout}')`)
  }

  const sessionMissing = await requireSession(repo, env.runTmux)
  if (sessionMissing !== null) return sessionMissing
  const sidR = resolveSidOrDie(repo)
  if ('error' in sidR) return sidR.error
  const sid = sidR.sid
  const pane = await resolvePaneTarget(repo, env.runTmux)
  if (pane === '') return die(`could not resolve pane target for ${repo}`)

  let stderr = `tm compact: sending /compact to ${repo} (sid=${sid}, timeout=${timeout}s)\n`

  const sent = await sendKeys(repo, '/compact', env.runTmux, process.env)
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
              `tm compact: ${repo} refused /compact — Claude Code reported ` +
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
  return {
    code: 1,
    stdout: '',
    stderr:
      stderr +
      `tm compact: ${repo} did not signal PostCompact within ${timeout}s — ` +
      'compaction may still be running, or the Stop hook is misconfigured. ' +
      `Check 'tm status ${repo}' and ${marker}.\n`,
  }
}
