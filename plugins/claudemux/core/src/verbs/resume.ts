/**
 * `tm resume <name> [checkpoint]` — relaunch a previous teammate session.
 */

import { formatResume } from './format'
import type { ResumeRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { resolveTargetEngine } from './resolve'

export interface ResumeArgs {
  readonly name: TeammateName
  readonly checkpoint: string | null
  readonly prompt: string | null
  readonly displayName: string | null
}

export async function resumeVerb(args: ResumeArgs, ctx: VerbContext): Promise<TmResult> {
  const engine = await resolveTargetEngine(args.name, ctx)
  if ('code' in engine) return engine

  const req: ResumeRequest = {
    name: args.name,
    checkpoint: args.checkpoint,
    prompt: args.prompt,
    displayName: args.displayName,
  }
  return formatResume(await engine.resume(req, ctx.engineContext))
}
