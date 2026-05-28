import type { Engine } from '../engine'
import { engineContext, resolveEngine } from './verb-common.js'

/** Codex rows for `tm states`, using the legacy REPO/SID/BUSY/LAST/PREVIEW columns. */
export async function codexStateRows(
  _nowSec: number,
  engine?: Engine,
): Promise<readonly string[][]> {
  const rows = await resolveEngine(engine).list(engineContext())
  return rows.map((row) => {
    return [
      row.name,
      row.extras['sidShort'] ?? '-',
      row.extras['busy'] ?? '-',
      row.extras['last'] ?? '-',
      row.extras['preview'] ?? '-',
    ]
  })
}
