/**
 * `tm send <name> --prompt p` — atomic round-trip. Decision 0024
 * §"Round-trips are atomic by default" makes wait the only path;
 * `--no-wait` is removed. The verb resolves the teammate through the
 * router and dispatches to `Engine.send`; the engine owns the
 * transport.
 */

import { formatTurn, teammateNotFound } from './format'
import type { SendRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'

export interface SendArgs {
  readonly name: TeammateName
  readonly prompt: string
  readonly timeoutMs: number | null
}

export async function sendVerb(args: SendArgs, ctx: VerbContext): Promise<TmResult> {
  const resolved = await ctx.router.resolve(args.name)
  if (resolved === null) return teammateNotFound(args.name)

  const req: SendRequest = {
    name: args.name,
    prompt: args.prompt,
    timeoutMs: args.timeoutMs,
  }
  return formatTurn(await resolved.engine.send(req, ctx.engineContext))
}
