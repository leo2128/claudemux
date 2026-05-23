/**
 * Teammate name parser + nested-name validation.
 *
 * Decision 0024 §"Nested teammate names" opens up names containing `/` —
 * the CLI accepts `tm spawn flow/flow-1`, the file builders treat the name
 * as opaque, and each engine encodes the name into whatever identifier its
 * runtime needs (tmux session, Codex registry directory, …). This module
 * is the one place CLI input is validated against the structural rules
 * common to every engine.
 *
 * Three structural rules:
 *
 *  - The name is at least one segment, each segment one-or-more characters
 *    drawn from `[A-Za-z0-9._-]`. Leading and trailing `/` are rejected;
 *    empty segments (`a//b`) are rejected.
 *
 *  - A name that contains `/` must not also contain the literal
 *    substring `__`. The Claude engine encodes `/` → `__` to land on a
 *    tmux-safe session name (`tmuxSessionName` in
 *    `engines/claude/persistence.ts`); a nested name like `flow__/1`
 *    would encode to `teammate-flow____1`, which collides with the
 *    encoding of `flow/_/1` — the simplest way to keep the encoding
 *    unambiguous is to reject this single overlap rather than reserve
 *    `__` in every raw name. A flat name like `flow__1` (no `/`) is
 *    legal and round-trips through the tmux session name unchanged.
 *
 *  - The name must not start with `.` and must not be exactly `.` / `..` —
 *    those collide with filesystem semantics for the engine extension
 *    directories under `/tmp/teammate-codex/<name>/`.
 */

import type { TeammateName } from '../engines/types'

const SEGMENT_REGEX = /^[A-Za-z0-9._-]+$/

export interface NameValidationFailure {
  readonly kind: 'invalid'
  readonly reason: string
}

export interface NameValidationOk {
  readonly kind: 'ok'
  readonly name: TeammateName
  readonly segments: readonly string[]
}

export type NameValidationResult = NameValidationOk | NameValidationFailure

/**
 * Validate a raw CLI teammate name. The accepted form is documented above.
 * Returns a discriminated result so the caller decides what error message
 * the user sees — the verb prints `tm spawn: invalid name 'foo/': empty
 * segment`, the router prints `tm: no such teammate: foo/` (still routed
 * through validation so a malformed name cannot accidentally hit the
 * filesystem builders).
 */
export function validateTeammateName(raw: string): NameValidationResult {
  if (raw.length === 0) return { kind: 'invalid', reason: 'empty' }
  if (raw.startsWith('/') || raw.endsWith('/')) {
    return { kind: 'invalid', reason: "leading or trailing '/'" }
  }
  if (raw.includes('/') && raw.includes('__')) {
    return {
      kind: 'invalid',
      reason: "a nested name (containing '/') must not also contain '__' — the Claude engine encodes '/' → '__' for tmux",
    }
  }
  const segments = raw.split('/')
  for (const seg of segments) {
    if (seg.length === 0) return { kind: 'invalid', reason: "empty segment ('//' not allowed)" }
    if (seg === '.' || seg === '..') return { kind: 'invalid', reason: `segment '${seg}' is reserved` }
    if (seg.startsWith('.')) return { kind: 'invalid', reason: `segment '${seg}' starts with '.'` }
    if (!SEGMENT_REGEX.test(seg)) {
      return {
        kind: 'invalid',
        reason: `segment '${seg}' contains characters outside [A-Za-z0-9._-]`,
      }
    }
  }
  return { kind: 'ok', name: raw, segments }
}

/** Whether the name has more than one segment — `flow/flow-1` is nested. */
export function isNestedName(name: TeammateName): boolean {
  return name.includes('/')
}
