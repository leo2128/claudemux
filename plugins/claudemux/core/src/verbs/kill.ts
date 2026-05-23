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

import { formatKill, teammateNotFound } from './format'
import type { TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'

export async function killVerb(name: TeammateName, ctx: VerbContext): Promise<TmResult> {
  const resolved = await ctx.router.resolve(name)
  if (resolved === null) return teammateNotFound(name)
  const result = await resolved.engine.kill({ name }, ctx.engineContext)
  if (result.kind === 'killed') await ctx.identity.remove(name)
  return formatKill(result)
}
