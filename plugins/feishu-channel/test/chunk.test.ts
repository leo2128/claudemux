import { describe, expect, test } from 'vitest'
import fc from 'fast-check'
import { chunk, type ChunkMode } from '../src/chunk'

const modeArb = fc.constantFrom<ChunkMode>('length', 'newline')

describe('chunk', () => {
  test('text within the limit is a single chunk', () => {
    expect(chunk('hello', 10)).toEqual(['hello'])
    expect(chunk('hello', 5)).toEqual(['hello'])
  })

  test('empty text yields a single empty chunk', () => {
    expect(chunk('', 10)).toEqual([''])
  })

  test('rejects a non-positive or non-integer limit', () => {
    expect(() => chunk('abc', 0)).toThrow(RangeError)
    expect(() => chunk('abc', -1)).toThrow(RangeError)
    expect(() => chunk('abc', 1.5)).toThrow(RangeError)
  })

  test('length mode cuts on a hard boundary', () => {
    expect(chunk('abcdef', 2, 'length')).toEqual(['ab', 'cd', 'ef'])
    expect(chunk('abcdefg', 3, 'length')).toEqual(['abc', 'def', 'g'])
  })

  test('newline mode prefers a blank-line boundary', () => {
    const out = chunk('aaaa\n\nbbbb', 6, 'newline')
    expect(out[0]).toBe('aaaa')
    expect(out[1]).toBe('bbbb')
  })

  test('newline mode prefers a word boundary over a mid-word cut', () => {
    const out = chunk('alpha bravo charlie', 13, 'newline')
    expect(out[0]).toBe('alpha bravo')
  })

  test('newline mode falls back to a hard cut when no boundary is near', () => {
    const out = chunk('aaaaaaaaaa', 4, 'newline')
    for (const c of out) expect(c.length).toBeLessThanOrEqual(4)
    expect(out.join('')).toBe('aaaaaaaaaa')
  })

  test('property: every chunk is within the limit', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 60 }), modeArb, (text, limit, mode) => {
        for (const c of chunk(text, limit, mode)) {
          expect(c.length).toBeLessThanOrEqual(limit)
        }
      }),
    )
  })

  test('property: every chunk is non-empty for non-empty input', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.integer({ min: 1, max: 60 }),
        modeArb,
        (text, limit, mode) => {
          for (const c of chunk(text, limit, mode)) {
            expect(c.length).toBeGreaterThan(0)
          }
        },
      ),
    )
  })

  test('property: length mode is lossless', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 1, max: 60 }), (text, limit) => {
        expect(chunk(text, limit, 'length').join('')).toBe(text)
      }),
    )
  })

  test('property: length mode chunk count is ceil(len / limit)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.integer({ min: 1, max: 60 }), (text, limit) => {
        expect(chunk(text, limit, 'length').length).toBe(Math.ceil(text.length / limit))
      }),
    )
  })
})
