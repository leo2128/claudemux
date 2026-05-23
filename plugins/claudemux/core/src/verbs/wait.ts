/**
 * `tm wait <name>` — the recovery seam. Decision 0024 §"Round-trips
 * are atomic by default" keeps this verb for the case where a previous
 * `send` / `spawn` aborted before reading the reply; a follow-up wait
 * picks up the next completion. Not the default path.
 */

import { formatTurn, teammateNotFound } from './format'
import type { TeammateName, WaitRequest } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'

export interface WaitArgs {
  readonly name: TeammateName
  readonly recoverFor: string | null
  readonly timeoutMs: number | null
}

export async function waitVerb(args: WaitArgs, ctx: VerbContext): Promise<TmResult> {
  const resolved = await ctx.router.resolve(args.name)
  if (resolved === null) return teammateNotFound(args.name)

  const req: WaitRequest = {
    name: args.name,
    recoverFor: args.recoverFor,
    timeoutMs: args.timeoutMs,
  }
  return formatTurn(await resolved.engine.wait(req, ctx.engineContext))
}
