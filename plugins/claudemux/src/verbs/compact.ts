/**
 * `tm compact <name>` — manual context compaction. Decision multi-engine-tui-architecture
 * §"Engine interface" uses this verb as the load-bearing example for
 * the discriminated-result design: the Codex engine returns
 * `{ kind: 'not-supported', reason: ... }` and the verb formatter
 * prints the one-line reason at exit 0.
 */

import { formatCompact } from './format'
import type { CompactRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { resolveTargetEngine } from './resolve'

export async function compactVerb(
  name: TeammateName,
  ctx: VerbContext,
  opts: { readonly timeoutMs: number | null } = { timeoutMs: null },
): Promise<TmResult> {
  const engine = await resolveTargetEngine(name, ctx)
  if ('code' in engine) return engine

  const req: CompactRequest = { name, timeoutMs: opts.timeoutMs }
  return formatCompact(await engine.compact(req, ctx.engineContext))
}
