/**
 * `tm ctx <name>` — report a teammate's context-window usage.
 */

import { formatContext } from './format'
import type { ContextRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { resolveTargetEngine } from './resolve'

export async function ctxVerb(
  name: TeammateName,
  ctx: VerbContext,
  opts: { readonly windowOverride: '' | '200k' | '1m' },
): Promise<TmResult> {
  const engine = await resolveTargetEngine(name, ctx)
  if ('code' in engine) return engine

  const req: ContextRequest = { name, windowOverride: opts.windowOverride }
  return formatContext(await engine.ctx(req, ctx.engineContext))
}
