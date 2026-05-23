/**
 * `tm states` — rich fleet listing. Decision 0024 amend §"Fleet-
 * visibility verbs" and the target tree (`states.ts: default impl:
 * aggregate Engine.status snapshots (rich)`) put this verb on
 * `Engine.list()` + per-teammate `Engine.status(name)` fan-out.
 *
 * The Phase 1 default below mirrors the `tm ls` shape: each row is
 * tab-delimited, with the per-teammate status appended. Phase 2's
 * `presentation/format-state.ts` will turn this into the column-aligned
 * rich view today's `tm states` produces; the verb-side wiring stays.
 */

import type { TmResult } from '../tm'
import type { VerbContext } from './context'

export async function statesVerb(ctx: VerbContext): Promise<TmResult> {
  const listings = (
    await Promise.all(ctx.engines.registered().map((engine) => engine.list(ctx.engineContext)))
  ).flat()

  if (listings.length === 0) return { code: 0, stdout: '', stderr: '' }

  const rows = await Promise.all(
    listings.map(async (row) => {
      const engine = ctx.engines.get(row.engine)
      if (engine === undefined) return `${row.name}\t${row.engine}\t${row.state}\t${row.cwd}`
      const status = await engine.status({ name: row.name, lines: null }, ctx.engineContext)
      if (status.kind !== 'present') {
        return `${row.name}\t${row.engine}\t${row.state}\t${row.cwd}`
      }
      return `${status.name}\t${status.engine}\t${status.state}\t${status.cwd}`
    }),
  )

  return { code: 0, stdout: `${rows.join('\n')}\n`, stderr: '' }
}
