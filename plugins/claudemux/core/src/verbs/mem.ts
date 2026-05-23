/**
 * `tm mem <name>` — project memory dump. Decision 0024 §"`history`
 * and `mem` stay" keeps the verb alive across engines. The Claude
 * engine reads `~/.claude/projects/<encoded>/memory/`; the Codex
 * engine returns `not-supported`.
 */

import { formatText, teammateNotFound } from './format'
import type { MemoryRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'

export async function memVerb(name: TeammateName, ctx: VerbContext): Promise<TmResult> {
  const resolved = await ctx.router.resolve(name)
  if (resolved === null) return teammateNotFound(name)

  const req: MemoryRequest = { name }
  return formatText('mem', await resolved.engine.mem(req, ctx.engineContext))
}
