/**
 * `tm states` — rich fleet listing.
 *
 * Each row carries seven cells:
 * `NAME REPO WORKTREE ENGINE STATE LAST PREVIEW`. The identity cells
 * (NAME / REPO / WORKTREE / ENGINE / STATE) come from the listing
 * itself; the runtime cells (LAST / PREVIEW) come from the
 * engine-private `extras` map. The combined `state` column
 * collapses the legacy `BUSY` cell — `state === 'busy'` is the only
 * way to read "the teammate is mid-turn", same signal, more readable.
 *
 * The verb owns the column alignment via `runColumn` so the table
 * reads the same way the legacy `tm states | column -t` did.
 */

import type { TmResult } from '../tm'
import { noEngineRegistered } from './format'
import type { VerbContext } from './context'

type StatesRow = readonly [
  string, string, string, string,
  string, string, string,
]

const HEADER: StatesRow = [
  'NAME',
  'REPO',
  'WORKTREE',
  'ENGINE',
  'STATE',
  'LAST',
  'PREVIEW',
]

/** Pull a string-typed extra; missing or non-string falls back to `-`. */
function cell(extras: Readonly<Record<string, string>>, key: string): string {
  const value = extras[key]
  return typeof value === 'string' && value.length > 0 ? value : '-'
}

/** Last path segment, or `-` when the path is empty / "/". */
function repoLeaf(path: string): string {
  if (path.length === 0) return '-'
  const trimmed = path.replace(/\/+$/, '')
  const slash = trimmed.lastIndexOf('/')
  const leaf = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
  return leaf.length === 0 ? '-' : leaf
}

export async function statesVerb(ctx: VerbContext): Promise<TmResult> {
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
      repoLeaf(row.repo),
      row.worktreeSlug ?? '-',
      row.engine,
      row.state,
      cell(row.extras, 'last'),
      cell(row.extras, 'preview'),
    ]),
  ]

  return ctx.runColumn(`${rows.map((row) => row.join('\t')).join('\n')}\n`)
}
