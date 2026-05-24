/**
 * `tm states` — rich fleet listing.
 *
 * Each row carries five cells: `REPO SID BUSY LAST PREVIEW`. The cells
 * come from `Engine.list()`'s per-row `extras` map (decision 0024
 * §"Engines extend row shape, not the verb"); an engine that omits a
 * key surfaces a `-` placeholder, matching legacy `cmd_states`.
 *
 * The verb owns the column alignment via `runColumn` so the table reads
 * the same way the legacy `tm states | column -t` did, byte for byte.
 */

import type { TmResult } from '../tm'
import { noEngineRegistered } from './format'
import type { VerbContext } from './context'

/** The five-cell row shape `tm states` renders. */
type StatesRow = readonly [string, string, string, string, string]

const HEADER: StatesRow = ['REPO', 'SID', 'BUSY', 'LAST', 'PREVIEW']

/** Pull a string-typed extra; missing or non-string falls back to `-`. */
function cell(extras: Readonly<Record<string, string>>, key: string): string {
  const value = extras[key]
  return typeof value === 'string' && value.length > 0 ? value : '-'
}

export async function statesVerb(ctx: VerbContext): Promise<TmResult> {
  // Same rule as `lsVerb`: an empty registry is a wiring failure, not a
  // fleet state. Surface it explicitly so a production process that forgets
  // to register an engine fails loudly here.
  const engines = ctx.engines.registered()
  if (engines.length === 0) return noEngineRegistered()

  const listings = (
    await Promise.all(engines.map((engine) => engine.list(ctx.engineContext)))
  ).flat()

  if (listings.length === 0) return { code: 0, stdout: '(no teammate sessions)\n', stderr: '' }

  const rows: StatesRow[] = [
    HEADER,
    ...listings.map<StatesRow>((row) => [
      row.name,
      cell(row.extras, 'sidShort'),
      cell(row.extras, 'busy'),
      cell(row.extras, 'last'),
      cell(row.extras, 'preview'),
    ]),
  ]

  // The `runColumn` result *is* the verb's result — legacy `cmd_states` ends
  // in `| column -t`, so `column`'s exit code, stdout, and stderr are what
  // `tm states` produces.
  return ctx.runColumn(`${rows.map((row) => row.join('\t')).join('\n')}\n`)
}
