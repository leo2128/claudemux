/**
 * `tm reload` — fan `/reload-plugins` out to one, many, or all
 * teammates.
 *
 * The verb is sugar over `tm send --no-wait <repo> --prompt
 * /reload-plugins`. Argument parsing and the repo fan-out are native;
 * each teammate's send dispatches into `claudeSend` in-process — no
 * subprocess.
 *
 * `cmd_reload`'s `(failed — ...)` line and keep-iterating `rc` are
 * dead code in bash: `cmd_send`'s `_send_keys` `die`s (`exit 1`) for a
 * non-running teammate rather than returning non-zero, which terminates
 * `tm reload` outright. So this reproduces what `tm reload` *does* —
 * stop at the first send that exits non-zero, and propagate that exit
 * code — not the unreachable intent.
 */

import { claudeSend } from './send'
import { die } from './tmux'
import { iterTeammates } from './tmux'
import type { ClaudeVerbEnv } from './env'
import type { TmResult } from '../../tm'

export async function claudeReload(args: readonly string[], env: ClaudeVerbEnv): Promise<TmResult> {
  let all = false
  const repos: string[] = []
  for (const arg of args) {
    if (arg === '--all') all = true
    else if (arg === '-h' || arg === '--help') return die('usage: tm reload <repo>... | --all')
    else if (arg.startsWith('-')) return die(`tm reload: unknown flag: ${arg}`)
    else repos.push(arg)
  }

  if (all) {
    if (repos.length > 0) return die('tm reload: --all conflicts with explicit repos')
    repos.push(...(await iterTeammates(env.runTmux)))
    if (repos.length === 0) {
      return { code: 0, stdout: '(no teammate sessions to reload)\n', stderr: '' }
    }
  } else if (repos.length === 0) {
    return die('usage: tm reload <repo>... | --all')
  }

  let stdout = ''
  for (const repo of repos) {
    stdout += `→ ${repo}: /reload-plugins\n`
    const sent = await claudeSend(['--no-wait', repo, '--prompt', '/reload-plugins'], env)
    // A non-zero `tm send` is `_send_keys`'s `die` that ends `tm
    // reload`; its own stderr went to `cmd_reload`'s `>/dev/null`, so
    // it is dropped.
    if (sent.code !== 0) return { code: sent.code, stdout, stderr: '' }
  }
  return { code: 0, stdout, stderr: '' }
}
