import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { generatePairingCode, PAIRING_CODE_LENGTH } from '../src/pairing'

describe('pairing', () => {
  test('generated codes have the expected length', () => {
    expect(generatePairingCode()).toHaveLength(PAIRING_CODE_LENGTH)
  })

  test('property: every generated code is lowercase hex of the fixed length', () => {
    fc.assert(
      fc.property(fc.constant(null), () => {
        expect(generatePairingCode()).toMatch(/^[0-9a-f]{6}$/)
      }),
      { numRuns: 1000 },
    )
  })

  test('generated codes vary — randomBytes is actually exercised', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generatePairingCode()))
    expect(codes.size).toBeGreaterThan(1)
  })
})
