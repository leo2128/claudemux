/**
 * Claude-engine state helpers — derive the per-teammate `extras` row the
 * verb layer ingests for the `tm states` table.
 *
 * Decision multi-engine-tui-architecture §"Engines extend row shape, not the verb" puts the
 * engine-private state fields on `TeammateListing.extras`. The verb
 * formatter reads keys it knows; an engine that does not fill a key
 * surfaces the `"-"` placeholder the legacy `tm states` produced.
 *
 * The keys this module writes:
 *
 *  - `sidShort` — the 8-character prefix of the current Claude session
 *    id, or `"?"` when no sid file is on disk. Matches `cmd_states`'s
 *    `${sid:0:8}` and its `?` fallback.
 *  - `busy` — `"yes"` when the `<sid>.busy` marker exists, `"no"`
 *    otherwise. Tracks the on-busy / on-stop hook ping-pong.
 *  - `last` — `${size}B/${age}` when the `<sid>.last` file is present
 *    and non-empty, `"-"` otherwise.
 *  - `preview` — first non-control character line of `<sid>.last`,
 *    truncated to 50 code points (matching `perl -CSD substr 0 50`),
 *    or `"(no first line)"` when empty, or `"-"` when no `.last` file.
 */

import { readFileSync, statSync, type Stats } from 'node:fs'

import { busyMarkerFor, lastFileFor, sidFile } from '../../persistence/paths'
import type { TeammateName } from '../types'

/** Trim trailing newlines without touching the rest of the string. */
function rstrip(text: string): string {
  return text.replace(/\n+$/, '')
}

/** Read a file only if it exists and is non-empty (`tm`'s `[[ -s file ]]`). */
function readIfNonEmpty(path: string): string | null {
  try {
    if (statSync(path).size === 0) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Lookup a teammate's session id, or `null` when the marker is missing. */
export function readSid(name: TeammateName): string | null {
  const raw = readIfNonEmpty(sidFile(name))
  return raw === null ? null : rstrip(raw)
}

/** Whether a path is a regular file (mirrors `[[ -f file ]]`). */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Format a second-count as a short relative age — `tm`'s `fmt_age`.
 * Boundaries are exclusive on the upper end, matching the bash arithmetic
 * (`(( age < 60 ))`).
 */
export function fmtAge(age: number): string {
  if (age < 60) return `${age}s`
  if (age < 3600) return `${Math.floor(age / 60)}m`
  if (age < 86400) return `${Math.floor(age / 3600)}h`
  return `${Math.floor(age / 86400)}d`
}

/**
 * The PREVIEW cell for one teammate — the first line of its `.last`,
 * with control characters stripped, truncated to 50 characters (code
 * points, as `tm`'s `perl -CSD substr` counts them). Empty after
 * stripping, or the file unreadable, → `(no first line)`.
 */
export function lastPreview(lastPath: string): string {
  let content: string
  try {
    content = readFileSync(lastPath, 'utf8')
  } catch {
    return '(no first line)'
  }
  const preview = [...(content.split('\n')[0] ?? '')]
    .filter((ch) => (ch.codePointAt(0) ?? 0) > 0x1f)
    .slice(0, 50)
    .join('')
  return preview.length > 0 ? preview : '(no first line)'
}

/** The five `tm states` cells for one teammate: derived from the on-disk markers. */
export interface ClaudeListingExtras {
  readonly sidShort: string
  readonly busy: 'yes' | 'no'
  readonly last: string
  readonly preview: string
}

/**
 * Compute the `states`-table cells for one teammate, sampling `now` once
 * so a multi-row scan keeps a single clock reading (matching `cmd_states`).
 */
export function listingExtras(name: TeammateName, now: number): ClaudeListingExtras {
  const sid = readSid(name)
  const sidShort = sid === null ? '?' : sid.slice(0, 8)
  const busy: 'yes' | 'no' = sid !== null && isRegularFile(busyMarkerFor(sid)) ? 'yes' : 'no'
  let last = '-'
  let preview = '-'
  if (sid !== null && sid.length > 0) {
    const lf = lastFileFor(sid)
    let stat: Stats | null
    try {
      stat = statSync(lf)
    } catch {
      stat = null
    }
    if (stat !== null && stat.size > 0) {
      const age = now - Math.floor(stat.mtimeMs / 1000)
      last = `${stat.size}B/${fmtAge(age)}`
      preview = lastPreview(lf)
    }
  }
  return { sidShort, busy, last, preview }
}
