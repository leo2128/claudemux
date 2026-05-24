/**
 * `tm kill <name>` — release the teammate. Decision 0024 amend lines
 * 163-169 fix the default impl: resolve through the router, ask the
 * engine to kill, remove the identity JSON on success. The "remove
 * identity" step is what frees the name for a subsequent `tm spawn`.
 *
 * The engine's `kill` is the single place that decides what "stop the
 * teammate" means for that engine (tmux session kill / Codex daemon
 * SIGTERM / etc); the verb owns identity bookkeeping and exit code.
 */

import { formatKill } from './format'
import type { TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'

/**
 * `tm kill` is idempotent: a missing teammate still has to clear stale
 * markers and return "not running" with exit 0. When the router cannot
 * resolve a name, the verb falls through to the Claude engine — its
 * `kill` is the only one that knows the tmux + on-disk marker layout the
 * legacy `cmd_kill` cleaned up unconditionally. A registered Codex
 * teammate would have been resolved by the router on the JSON path; if
 * neither router resolves a name, it cannot be a live Codex daemon.
 */
export async function killVerb(name: TeammateName, ctx: VerbContext): Promise<TmResult> {
  const resolved = await ctx.router.resolve(name)
  const engine = resolved?.engine ?? ctx.engines.get('claude')
  if (engine === undefined) return formatKill(name, { kind: 'not-found' })
  const result = await engine.kill({ name }, ctx.engineContext)
  if (result.kind === 'killed') await ctx.identity.remove(name)
  return formatKill(name, result)
}
