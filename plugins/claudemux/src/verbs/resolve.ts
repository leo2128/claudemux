import type { Engine } from '../engines/engine'
import type { TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { noEngineRegistered } from './format'

export async function resolveTargetEngine(
  name: TeammateName,
  ctx: VerbContext,
): Promise<Engine | TmResult> {
  const resolved = await ctx.router.resolve(name)
  if (resolved !== null) return resolved.engine
  return ctx.engines.get('claude') ?? noEngineRegistered()
}
