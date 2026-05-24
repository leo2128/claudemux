import type { Engine } from '../engines/engine'
import type { TeammateName } from '../engines/types'
import { validateTeammateName } from '../identity/name'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { noEngineRegistered } from './format'

function isCodexPrefixName(name: string): boolean {
  return name.startsWith('codex-') || name.startsWith('codex/')
}

export async function resolveTargetEngine(
  name: TeammateName,
  ctx: VerbContext,
): Promise<Engine | TmResult> {
  const validation = validateTeammateName(name)
  if (validation.kind !== 'ok' && isCodexPrefixName(name)) {
    return {
      code: 1,
      stdout: '',
      stderr: `tm: invalid codex teammate name '${name}': ${validation.reason}\n`,
    }
  }
  const resolved = await ctx.router.resolve(name)
  if (resolved !== null) return resolved.engine
  if (isCodexPrefixName(name)) {
    const codex = ctx.engines.get('codex')
    if (codex !== undefined) return codex
  }
  return ctx.engines.get('claude') ?? noEngineRegistered()
}
