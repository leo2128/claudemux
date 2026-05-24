/**
 * `tm wait <name>` — the recovery seam. Decision 0024 §"Round-trips
 * are atomic by default" keeps this verb for the case where a previous
 * `send` / `spawn` aborted before reading the reply; a follow-up wait
 * picks up the next completion. Not the default path.
 */

import { formatTurn } from './format'
import type { TeammateName, WaitRequest } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { resolveTargetEngine } from './resolve'

export interface WaitArgs {
  readonly name: TeammateName
  readonly recoverFor: string | null
  readonly timeoutMs: number | null
  readonly fresh: boolean
  readonly paneQuiet: boolean
}

export async function waitVerb(args: WaitArgs, ctx: VerbContext): Promise<TmResult> {
  const engine = await resolveTargetEngine(args.name, ctx)
  if ('code' in engine) return engine
  if (args.fresh && engine.kind !== 'claude') {
    return { code: 1, stdout: '', stderr: 'tm: tm wait: --fresh is not supported for codex teammates\n' }
  }
  if (args.paneQuiet && engine.kind !== 'claude') {
    return { code: 1, stdout: '', stderr: 'tm: tm wait: --pane-quiet is not supported for codex teammates\n' }
  }

  const req: WaitRequest = {
    name: args.name,
    recoverFor: args.recoverFor,
    timeoutMs: args.timeoutMs,
    fresh: args.fresh,
    paneQuiet: args.paneQuiet,
  }
  return formatTurn(await engine.wait(req, ctx.engineContext))
}
