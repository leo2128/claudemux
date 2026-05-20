import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import { MAX_FILENAME_LENGTH, sanitizeInboundFileName } from '../src/filename'

describe('sanitizeInboundFileName', () => {
  test('strips directory parts', () => {
    expect(sanitizeInboundFileName('a/b/c.png')).toBe('c.png')
    expect(sanitizeInboundFileName('a\\b\\c.png')).toBe('c.png')
  })

  test('defuses path traversal', () => {
    expect(sanitizeInboundFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeInboundFileName('..')).toBe('file')
    expect(sanitizeInboundFileName('....')).toBe('file')
  })

  test('falls back to "file" for an empty result', () => {
    expect(sanitizeInboundFileName('')).toBe('file')
    expect(sanitizeInboundFileName('///')).toBe('file')
  })

  test('strips leading dots so the result is never hidden', () => {
    expect(sanitizeInboundFileName('.hidden')).toBe('hidden')
    expect(sanitizeInboundFileName('.env')).toBe('env')
  })

  test('keeps ordinary names intact', () => {
    expect(sanitizeInboundFileName('report.pdf')).toBe('report.pdf')
    expect(sanitizeInboundFileName('my-photo_2.JPG')).toBe('my-photo_2.JPG')
  })

  test('replaces unsafe characters with underscores', () => {
    expect(sanitizeInboundFileName('a b?c.png')).toBe('a_b_c.png')
  })

  test('property: result is always a safe single path component', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const out = sanitizeInboundFileName(name)
        expect(out.length).toBeGreaterThan(0)
        expect(out.length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH)
        expect(out).not.toContain('/')
        expect(out).not.toContain('\\')
        expect(out.startsWith('.')).toBe(false)
        expect(out).not.toBe('.')
        expect(out).not.toBe('..')
        expect(/^[A-Za-z0-9._-]+$/.test(out)).toBe(true)
      }),
    )
  })

  test('property: long names are truncated to the bound', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 200, maxLength: 400 }), (name) => {
        expect(sanitizeInboundFileName(name).length).toBeLessThanOrEqual(MAX_FILENAME_LENGTH)
      }),
    )
  })
})
