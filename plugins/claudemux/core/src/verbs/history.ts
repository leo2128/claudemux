/**
 * `tm history <name> [index]` — turn-by-turn history. Decision 0024
 * §"`history` and `mem` stay" keeps the verb alive on both engines.
 * The Claude engine reads `~/.claude/projects/<encoded>/*.jsonl`;
 * the Codex engine returns `not-supported` until upstream exposes
 * thread enumeration.
 */

import { formatHistory, teammateNotFound } from './format'
import type { HistoryRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'

export interface HistoryArgs {
  readonly name: TeammateName
  /** `null` = list view; non-null = detail of the given turn index. */
  readonly index: number | null
}

export async function historyVerb(args: HistoryArgs, ctx: VerbContext): Promise<TmResult> {
  const resolved = await ctx.router.resolve(args.name)
  if (resolved === null) return teammateNotFound(args.name)

  const req: HistoryRequest = { name: args.name, index: args.index }
  return formatHistory(await resolved.engine.history(req, ctx.engineContext))
}
