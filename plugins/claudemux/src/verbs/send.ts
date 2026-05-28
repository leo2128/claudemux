/**
 * `tm send <name> --prompt p` — atomic round-trip. Decision multi-engine-tui-architecture
 * §"Round-trips are atomic by default" makes wait the only path;
 * `--no-wait` is removed. The verb resolves the teammate through the
 * router and dispatches to `Engine.send`; the engine owns the
 * transport.
 */

import { formatTurn } from './format'
import type { SendRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { resolveTargetEngine } from './resolve'

export interface SendArgs {
  readonly name: TeammateName
  readonly prompt: string
  readonly timeoutMs: number | null
  readonly paneQuiet: boolean
}

export async function sendVerb(args: SendArgs, ctx: VerbContext): Promise<TmResult> {
  const engine = await resolveTargetEngine(args.name, ctx)
  if ('code' in engine) return engine
  if (args.paneQuiet && engine.kind !== 'claude') {
    return { code: 1, stdout: '', stderr: 'tm: tm send: --pane-quiet is not supported for codex teammates\n' }
  }

  const req: SendRequest = {
    name: args.name,
    prompt: args.prompt,
    timeoutMs: args.timeoutMs,
    paneQuiet: args.paneQuiet,
  }
  return formatTurn(await engine.send(req, ctx.engineContext))
}
