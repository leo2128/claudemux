/**
 * Claude-engine tmux helpers — the session-probe and pane-target lookups
 * the hot-path verbs share. Decision multi-engine-tui-architecture §"Verb is the abstraction" pins
 * the session-name encoding to `persistence/paths.ts`; this
 * module is the thin runtime layer on top of that, so a verb that needs
 * to ask "is this teammate's tmux session alive?" or "what pane should I
 * send keys to?" calls one helper instead of repeating the same
 * `has-session -t '=…'` / `list-sessions -F '#{session_id} #{session_name}'`
 * argv at every site.
 */

import { TMUX_SESSION_PREFIX, tmuxSessionName } from '../../persistence/paths'
import type { TeammateName } from '../types'
import type { TmResult } from '../../tm'
import type { TmuxRunner } from '../../tmux'

/** `tm`'s `die`: one `tm: <message>` line on stderr, exit 1. */
export function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

/** Whether a session of this name is currently up — `has-session -t '=NAME'`. */
export async function sessionExists(
  session: string,
  runTmux: TmuxRunner,
): Promise<boolean> {
  try {
    return (await runTmux(['has-session', '-t', `=${session}`])).code === 0
  } catch {
    return false
  }
}

/**
 * `tm`'s `require_session`: a `die` `TmResult` when the teammate's tmux
 * session does not exist, or `null` when it does. The `=` modifier in
 * `has-session -t '=NAME'` is tmux's exact-match qualifier — without it
 * a teammate named `teammate-foo` would also match `teammate-foo-bar`.
 */
export async function requireSession(
  name: TeammateName,
  runTmux: TmuxRunner,
): Promise<TmResult | null> {
  const session = tmuxSessionName(name)
  if (await sessionExists(session, runTmux)) return null
  return die(`no such teammate session: ${name} (tmux=${session}; try 'tm ls')`)
}

/**
 * `tm`'s `resolve_pane_target`: the tmux internal session id of a
 * teammate's session, or `''` when none matches. tmux pane targets cannot
 * take the `=NAME` exact-match modifier, so the id is resolved instead.
 */
export async function resolvePaneTarget(
  name: TeammateName,
  runTmux: TmuxRunner,
): Promise<string> {
  const session = tmuxSessionName(name)
  let listing = ''
  try {
    listing = (await runTmux(['list-sessions', '-F', '#{session_id} #{session_name}'])).stdout
  } catch {
    listing = ''
  }
  for (const line of listing.split('\n')) {
    const space = line.indexOf(' ')
    if (space >= 0 && line.slice(space + 1) === session) return line.slice(0, space)
  }
  return ''
}

/** The session field of one `tmux ls` line — `awk -F:` `$1`. */
export function sessionField(line: string): string {
  const colon = line.indexOf(':')
  return colon >= 0 ? line.slice(0, colon) : line
}

/** The running teammate names from a `tmux ls` stdout listing. */
export function teammateNamesFromTmuxLs(listing: string): string[] {
  const out: string[] = []
  for (const line of listing.split('\n')) {
    const field = sessionField(line)
    if (field.startsWith(TMUX_SESSION_PREFIX)) {
      out.push(field.slice(TMUX_SESSION_PREFIX.length))
    }
  }
  return out
}

/** `tm`'s `iter_repos` — the running teammate repo names from a tmux runner. */
export async function iterTeammates(runTmux: TmuxRunner): Promise<string[]> {
  let listing = ''
  try {
    listing = (await runTmux(['ls'])).stdout
  } catch {
    listing = ''
  }
  return teammateNamesFromTmuxLs(listing)
}
