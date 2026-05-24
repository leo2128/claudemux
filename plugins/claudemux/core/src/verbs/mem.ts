/**
 * `tm mem <name>` — project memory dump. Decision 0024 §"`history`
 * and `mem` stay" keeps the verb alive across engines. The Claude
 * engine reads `~/.claude/projects/<encoded>/memory/`; the Codex
 * engine returns `not-supported`.
 */

import type { MemoryRequest, TeammateName, TextResult } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { resolveTargetEngine } from './resolve'

function formatMem(engineKind: string, result: TextResult): TmResult {
  if (result.tmResult !== undefined) return result.tmResult
  switch (result.kind) {
    case 'text':
      return { code: 0, stdout: result.text, stderr: '' }
    case 'not-supported':
      return {
        code: 0,
        stdout: '',
        stderr:
          engineKind === 'claude'
            ? `${result.reason}\n`
            : `  not supported: ${result.reason}\n`,
      }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: ${result.message}\n` }
  }
}

export async function memVerb(name: TeammateName, ctx: VerbContext): Promise<TmResult> {
  const engine = await resolveTargetEngine(name, ctx)
  if ('code' in engine) return engine

  const req: MemoryRequest = { name }
  return formatMem(engine.kind, await engine.mem(req, ctx.engineContext))
}
