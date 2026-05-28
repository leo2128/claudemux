/**
 * Teammate name validation.
 *
 * Schema 2 made teammate names flat opaque identifiers — fully
 * decoupled from any repository path. A name must start with an
 * ASCII alphanumeric character and may contain only ASCII
 * alphanumerics, `-`, and `_`. `/` is forbidden, as is anything that
 * looks like a path segment (`.`, `..`, leading `.`).
 *
 * The flat shape is what `tmuxSessionName` and every cross-process
 * file path under `/tmp` consumes directly — no encoding pass, no
 * round-trip ambiguity.
 */

import type { TeammateName } from '../engines/types'

const NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export interface NameValidationFailure {
  readonly kind: 'invalid'
  readonly reason: string
}

export interface NameValidationOk {
  readonly kind: 'ok'
  readonly name: TeammateName
}

export type NameValidationResult = NameValidationOk | NameValidationFailure

/**
 * Validate a raw CLI teammate name. The accepted form is documented
 * above. Returns a discriminated result so the caller decides what
 * error message the user sees.
 */
export function validateTeammateName(raw: string): NameValidationResult {
  if (raw.length === 0) return { kind: 'invalid', reason: 'empty' }
  if (raw.includes('/')) {
    return {
      kind: 'invalid',
      reason: "names are flat — '/' is forbidden (use a slug like 'flow-auth' instead)",
    }
  }
  if (raw === '.' || raw === '..') {
    return { kind: 'invalid', reason: `name '${raw}' is reserved` }
  }
  if (raw.startsWith('.')) {
    return { kind: 'invalid', reason: `name '${raw}' starts with '.'` }
  }
  if (!NAME_REGEX.test(raw)) {
    return {
      kind: 'invalid',
      reason:
        "name must start with [A-Za-z0-9] and contain only [A-Za-z0-9_-] (no '/', no '.')",
    }
  }
  return { kind: 'ok', name: raw }
}
