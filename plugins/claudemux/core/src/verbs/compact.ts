/**
 * `tm compact <name>` — manual context compaction. Decision 0024
 * §"Engine interface" uses this verb as the load-bearing example for
 * the discriminated-result design: the Codex engine returns
 * `{ kind: 'not-supported', reason: ... }` and the verb formatter
 * prints the one-line reason at exit 0.
 */

import { formatCompact, teammateNotFound } from './format'
import type { CompactRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'

export async function compactVerb(name: TeammateName, ctx: VerbContext): Promise<TmResult> {
  const resolved = await ctx.router.resolve(name)
  if (resolved === null) return teammateNotFound(name)

  const req: CompactRequest = { name }
  return formatCompact(await resolved.engine.compact(req, ctx.engineContext))
}
