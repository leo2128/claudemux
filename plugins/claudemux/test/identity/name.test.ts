/**
 * Coverage for the flat-name validator. Schema 2 made teammate names
 * flat opaque identifiers — `/` is forbidden, ASCII alnum + `_` / `-`
 * only, no `.`-leading segment.
 */

import { describe, expect, test } from 'vitest'

import { validateTeammateName } from '../../src/identity/name'

describe('validateTeammateName — flat name rules', () => {
  test('a typical flat name is accepted', () => {
    const result = validateTeammateName('flow-auth-7d3a')
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.name).toBe('flow-auth-7d3a')
    }
  })

  test('an alphanumeric-only name is accepted', () => {
    expect(validateTeammateName('flow1').kind).toBe('ok')
  })

  test('a name containing / is rejected', () => {
    const result = validateTeammateName('flow/auth')
    expect(result.kind).toBe('invalid')
    if (result.kind === 'invalid') {
      expect(result.reason).toMatch(/\//)
    }
  })

  test('a name leading with - is rejected (regex requires alnum first)', () => {
    expect(validateTeammateName('-flow').kind).toBe('invalid')
  })

  test('. and .. names are rejected', () => {
    expect(validateTeammateName('.').kind).toBe('invalid')
    expect(validateTeammateName('..').kind).toBe('invalid')
    expect(validateTeammateName('.hidden').kind).toBe('invalid')
  })

  test('characters outside [A-Za-z0-9._-] are rejected', () => {
    expect(validateTeammateName('foo bar').kind).toBe('invalid')
    expect(validateTeammateName('foo*').kind).toBe('invalid')
    expect(validateTeammateName('foo.bar').kind).toBe('invalid')
  })

  test('empty name is rejected', () => {
    expect(validateTeammateName('').kind).toBe('invalid')
  })

  test('underscores are allowed in the body', () => {
    expect(validateTeammateName('flow_1').kind).toBe('ok')
  })
})
