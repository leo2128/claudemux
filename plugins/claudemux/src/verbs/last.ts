/**
 * `tm last <name>` — reprint the last completed assistant reply.
 */

import type { LastRequest, TeammateName, TextResult } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { resolveTargetEngine } from './resolve'

function formatLast(result: TextResult): TmResult {
  if (result.tmResult !== undefined) return result.tmResult
  switch (result.kind) {
    case 'text':
      return { code: 0, stdout: result.text, stderr: '' }
    case 'not-found':
      return { code: 1, stdout: '', stderr: `tm: last: ${result.reason}\n` }
    case 'not-supported':
      return { code: 0, stdout: '', stderr: `  not supported: ${result.reason}\n` }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: ${result.message}\n` }
  }
}

export async function lastVerb(
  name: TeammateName,
  ctx: VerbContext,
  options: { readonly verbose?: boolean } = {},
): Promise<TmResult> {
  const engine = await resolveTargetEngine(name, ctx)
  if ('code' in engine) return engine

  const req: LastRequest = { name, verbose: options.verbose === true }
  return formatLast(await engine.last(req, ctx.engineContext))
}
