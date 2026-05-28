/**
 * `tm ls` — fleet-wide teammate listing. Decision multi-engine-tui-architecture amend
 * §"Fleet-visibility verbs" makes this verb engine-agnostic: it
 * iterates every registered engine, calls `Engine.list()` in parallel,
 * and concatenates the rows. A Codex daemon teammate with no tmux
 * session is therefore visible to `tm ls` for the first time.
 *
 * The default impl below is the one decision multi-engine-tui-architecture amend lines 150-155
 * lock in. Engines do not override `tm ls` unless their listing output
 * needs to differ from the shared format — and even then they extend
 * the row shape, not the verb.
 */

import { formatListing, noEngineRegistered } from './format'
import type { VerbContext } from './context'
import type { TmResult } from '../tm'

export async function lsVerb(ctx: VerbContext): Promise<TmResult> {
  // An empty registry means production wiring is incomplete — the verb must
  // surface that loudly, not silently report "no teammates". A zero-engine
  // process is a misconfiguration, not a fleet state.
  const engines = ctx.engines.registered()
  if (engines.length === 0) return noEngineRegistered()

  const listings = await Promise.all(engines.map((engine) => engine.list(ctx.engineContext)))
  return formatListing(listings.flat())
}
