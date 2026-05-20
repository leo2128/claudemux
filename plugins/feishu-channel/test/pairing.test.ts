import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import { generatePairingCode, isPairingCode, PAIRING_CODE_LENGTH } from '../src/pairing'

describe('pairing', () => {
  test('generated codes have the expected length', () => {
    expect(generatePairingCode()).toHaveLength(PAIRING_CODE_LENGTH)
  })

  test('isPairingCode accepts a well-formed code', () => {
    expect(isPairingCode('00ff1a')).toBe(true)
  })

  test('isPairingCode rejects malformed codes', () => {
    expect(isPairingCode('')).toBe(false)
    expect(isPairingCode('ABCDEF')).toBe(false) // uppercase
    expect(isPairingCode('12345')).toBe(false) // too short
    expect(isPairingCode('1234567')).toBe(false) // too long
    expect(isPairingCode('12345g')).toBe(false) // non-hex
    expect(isPairingCode(' 12345')).toBe(false) // whitespace
  })

  test('property: every generated code passes isPairingCode', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        expect(isPairingCode(generatePairingCode())).toBe(true)
      }),
      { numRuns: 1000 },
    )
  })

  test('property: isPairingCode matches the 6-lowercase-hex shape exactly', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(isPairingCode(s)).toBe(/^[0-9a-f]{6}$/.test(s))
      }),
    )
  })
})
