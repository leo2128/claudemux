/**
 * Splitting long outbound replies into Feishu-sized messages.
 */

export type ChunkMode = 'length' | 'newline'

/**
 * Split `text` into chunks no longer than `limit` characters.
 *
 * - `length` mode is lossless — `chunk(t, n, 'length').join('') === t`. It cuts
 *   on a hard character boundary.
 * - `newline` mode prefers a paragraph, line, or word boundary at or before
 *   `limit` so chunks read naturally; the boundary whitespace between chunks
 *   is consumed, so this mode is not lossless.
 *
 * Every returned chunk is non-empty and at most `limit` characters. Text that
 * already fits is returned as a single chunk, so empty input yields `['']` and
 * a caller always has something to send.
 */
export function chunk(text: string, limit: number, mode: ChunkMode = 'length'): string[] {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`chunk limit must be an integer >= 1, got ${limit}`)
  }
  if (text.length <= limit) return [text]

  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    const cut = mode === 'newline' ? preferredCut(rest, limit) : limit
    out.push(rest.slice(0, cut))
    const next = rest.slice(cut)
    rest = mode === 'newline' ? next.replace(/^\s+/, '') : next
  }
  if (rest.length > 0) out.push(rest)
  return out
}

/**
 * Pick a cut point at or before `limit` that lands on a natural boundary —
 * a blank line, a newline, then a space, in that order of preference. Falls
 * back to a hard cut at `limit` when no boundary sits in the second half of
 * the window, since cutting too early would make uselessly small chunks.
 *
 * The returned cut is always in [1, limit], so the loop in `chunk` always
 * makes progress.
 */
function preferredCut(text: string, limit: number): number {
  const half = limit / 2
  const paragraph = text.lastIndexOf('\n\n', limit)
  if (paragraph > half) return paragraph
  const line = text.lastIndexOf('\n', limit)
  if (line > half) return line
  const space = text.lastIndexOf(' ', limit)
  if (space > half) return space
  return limit
}
