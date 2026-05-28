/**
 * `tm status <name>` — per-teammate snapshot. Decision multi-engine-tui-architecture amend
 * lines 157-161 fix the default impl: resolve the teammate name
 * through the router, hand the engine the request, format the result.
 * A teammate that has no tmux session (a Codex daemon teammate)
 * resolves through the same path; the verb has no tmux knowledge.
 */

import { formatStatus, teammateNotFound } from './format'
import type { TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'

export async function statusVerb(
  name: TeammateName,
  ctx: VerbContext,
  options: { lines: number | null } = { lines: null },
): Promise<TmResult> {
  const resolved = await ctx.router.resolve(name)
  if (resolved === null) return teammateNotFound(name)
  const status = await resolved.engine.status(
    { name, lines: options.lines },
    ctx.engineContext,
  )
  return formatStatus(status)
}
