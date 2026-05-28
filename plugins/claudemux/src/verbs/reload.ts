/**
 * `tm reload <name>` — ask one teammate to reload its plugin set.
 */

import { formatReload } from './format'
import type { ReloadRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { resolveTargetEngine } from './resolve'

export async function reloadVerb(name: TeammateName, ctx: VerbContext): Promise<TmResult> {
  const engine = await resolveTargetEngine(name, ctx)
  if ('code' in engine) return engine

  const req: ReloadRequest = { name }
  return formatReload(await engine.reload(req, ctx.engineContext))
}
