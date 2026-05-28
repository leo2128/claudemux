/**
 * Post-turn output helpers — what `tm send` and `tm wait` print after a
 * Stop fires (or a timeout decides). The reply text goes to stdout via
 * `printLastOrEmpty`; the post-turn ctx echo goes to stderr via
 * `echoCtxToStderr`. Centralised so the two verbs render identically.
 */

import { readIfNonEmpty, resolveSid } from './idle'
import { lastFileFor } from '../../persistence/paths'
import { claudeCtxLine } from './ctx'
import type { ClaudeCtxEnv } from './ctx'
import type { TeammateName } from '../types'

/**
 * `tm`'s `_print_last_or_empty`: the teammate's `<sid>.last` content,
 * or the documented sentinel line when the file is missing or zero
 * bytes. Always exit 0; the verb wrapper decides what code to ship.
 */
export function printLastOrEmpty(name: TeammateName): string {
  const sid = resolveSid(name)
  if (sid === null) return `(no sid for ${name})\n`
  const reply = readIfNonEmpty(lastFileFor(sid))
  if (reply === null) {
    return '(no text reply this turn — tool-only, /compact, /clear, or fresh spawn)\n'
  }
  // `cat` does not append a newline; the file's own trailing newline is
  // what shapes the printed line. Reproduce that verbatim.
  return reply
}

/**
 * `tm`'s `_echo_ctx_to_stderr`: the teammate's post-turn ctx line,
 * prefixed with `ctx: `, on stderr. Soft-fails: an unreadable transcript
 * or a sid that cannot be resolved drops the line silently.
 */
export function echoCtxToStderr(name: TeammateName, env: ClaudeCtxEnv): string {
  // Reuse `claudeCtxLine` — its `?` diagnostic shape would also be a
  // soft-fail, so any `name:` prefix indicates an unreadable transcript;
  // only the formatted success line is echoed (the part after `<name>: `).
  const body = claudeCtxLine(name, '', env)
  if (body.includes(': ? (')) return ''
  const prefix = `${name}: `
  const data = body.startsWith(prefix) ? body.slice(prefix.length) : body
  return `ctx: ${data}\n`
}
