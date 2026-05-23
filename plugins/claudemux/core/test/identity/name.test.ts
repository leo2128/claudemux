/**
 * Regression coverage for the `__` rejection rule introduced in Phase 2a-1.
 *
 * The first cut of `validateTeammateName` rejected any raw name containing
 * `__` on the grounds that the Claude engine's tmux session-name encoding
 * uses `__` to stand in for `/`. That broke live legacy single-segment
 * teammates like `flow__1`, whose tmux session `teammate-flow__1` was
 * already alive on dispatcher machines. The current rule only rejects
 * `__` when the name also contains `/` (the only case in which the
 * encoding cannot be reversed unambiguously). These tests pin that.
 */

import { describe, expect, test } from 'vitest'

import { validateTeammateName, isNestedName } from '../../src/identity/name'

describe('validateTeammateName — __ rule', () => {
  test('a flat name containing __ is accepted (legacy teammate-flow__1 stays reachable)', () => {
    const result = validateTeammateName('flow__1')
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.name).toBe('flow__1')
      expect(result.segments).toEqual(['flow__1'])
    }
  })

  test('a nested name without __ is accepted', () => {
    const result = validateTeammateName('flow/flow-1')
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.segments).toEqual(['flow', 'flow-1'])
    }
  })

  test('a name that contains both / and __ is rejected to keep the tmux encoding round-trippable', () => {
    const result = validateTeammateName('flow__/1')
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') {
      expect(result.reason).toMatch(/__/)
    }
  })

  test('leading / or trailing / is rejected', () => {
    expect(validateTeammateName('/flow').kind).toBe('invalid')
    expect(validateTeammateName('flow/').kind).toBe('invalid')
  })

  test('empty segment (a//b) is rejected', () => {
    expect(validateTeammateName('a//b').kind).toBe('invalid')
  })

  test('. and .. segments are rejected', () => {
    expect(validateTeammateName('.').kind).toBe('invalid')
    expect(validateTeammateName('..').kind).toBe('invalid')
    expect(validateTeammateName('a/./b').kind).toBe('invalid')
  })

  test('characters outside [A-Za-z0-9._-] in a segment are rejected', () => {
    expect(validateTeammateName('foo bar').kind).toBe('invalid')
    expect(validateTeammateName('foo*').kind).toBe('invalid')
  })

  test('isNestedName returns true only when the name contains /', () => {
    expect(isNestedName('flow__1')).toBe(false)
    expect(isNestedName('flow/1')).toBe(true)
  })
})
