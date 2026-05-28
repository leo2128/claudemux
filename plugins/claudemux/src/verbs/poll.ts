/**
 * `tm poll <repo> <regex> [timeout]` — block until a teammate's pane
 * matches a regex, or a timeout elapses (a diagnostic verb).
 *
 * The poll loop is native; the match itself delegates to the real
 * `grep -E`, the way `states` delegates alignment to `column`. `tm`'s
 * `capture-pane | grep -qE` runs under `set -o pipefail`, so a match
 * needs both the capture to succeed and `grep` to exit 0.
 *
 * Claude-only at the verb level: the codex driver does not run inside
 * tmux, so a `tm poll codex-1 ...` falls through to the no-session
 * error (which is the same shape tmux would emit anyway).
 */

import { requireSession, resolvePaneTarget } from '../engines/claude/tmux'
import { isNonNegativeInteger, sleepMs } from '../engines/claude/clock'
import type { TmResult } from '../tm'
import type { GrepRunner } from '../grep'
import type { TmuxRunner } from '../tmux'

export interface PollEnv {
  readonly runTmux: TmuxRunner
  readonly runGrep: GrepRunner
}

export async function pollVerb(args: readonly string[], env: PollEnv): Promise<TmResult> {
  const repo = args[0] ?? ''
  const pattern = args[1] ?? ''
  if (repo === '' || pattern === '') {
    return die('usage: tm poll <repo> <regex> [timeout=180]')
  }
  // `||`, not `??`: `tm`'s `${3:-180}` also defaults on an empty-string arg.
  const timeoutArg = args[2] || '180'

  const sessionMissing = await requireSession(repo, env.runTmux)
  if (sessionMissing !== null) return sessionMissing

  const pane = await resolvePaneTarget(repo, env.runTmux)
  if (pane === '') return die(`could not resolve pane target for ${repo}`)

  // Same `[[ ^[0-9]+$ ]]` guard `send` / `wait` / `compact` use for their
  // `--timeout` — a malformed value would otherwise become a NaN loop.
  if (!isNonNegativeInteger(timeoutArg)) return { code: 1, stdout: '', stderr: '' }
  const end = Math.floor(Date.now() / 1000) + Number(timeoutArg)
  while (Math.floor(Date.now() / 1000) < end) {
    const capture = await env.runTmux(['capture-pane', '-t', pane, '-p', '-S', '-300'])
    if (capture.code === 0 && (await env.runGrep(pattern, capture.stdout)) === 0) {
      return { code: 0, stdout: `matched: ${pattern}\n`, stderr: '' }
    }
    await sleepMs(3000)
  }
  return {
    code: 1,
    stdout: '',
    stderr: `tm: timeout after ${timeoutArg}s waiting for /${pattern}/ in ${repo}\n`,
  }
}

function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}
