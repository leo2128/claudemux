/**
 * Pins the prefix detector used by `tm resume`'s error path. The
 * function gates the actionable "looks like a tm-history prefix" hint,
 * so any drift here decides between a misleading "wrong repo" message
 * and a useful one. Misses on the no-match side are merely a lost hint;
 * false matches on the match side would attach the hint to genuine
 * non-UUID inputs (e.g. a teammate name pasted by mistake), so the
 * tests pin both directions.
 */

import { describe, expect, test } from 'vitest'

import { looksLikeUuidPrefix } from '../../src/identity/uuid-prefix'

describe('looksLikeUuidPrefix', () => {
  test('an 8-char hex run (the tm history ID column) is a prefix', () => {
    expect(looksLikeUuidPrefix('fa48af8f')).toBe(true)
  })

  test('a partial dashed UUID is a prefix', () => {
    expect(looksLikeUuidPrefix('fa48af8f-2d2e')).toBe(true)
    expect(looksLikeUuidPrefix('fa48af8f-2d2e-4fd2-84d5')).toBe(true)
  })

  test('a single hex char counts as a prefix — the helpful hint is cheap to over-fire on hex strings', () => {
    expect(looksLikeUuidPrefix('a')).toBe(true)
  })

  test('a full canonical UUID is not a prefix (the strict regex would have accepted it upstream)', () => {
    expect(looksLikeUuidPrefix('fa48af8f-2d2e-4fd2-84d5-aa698ed8bb43')).toBe(false)
  })

  test('the 32-hex no-dash form is not a prefix — it carries the full UUID body without the canonical dashes that history.startsWith expects', () => {
    expect(looksLikeUuidPrefix('fa48af8f2d2e4fd284d5aa698ed8bb43')).toBe(false)
  })

  test('a 12-hex no-dash run is not a prefix — position 8 must be a dash to match a canonical id, so the hint would point at a path tm history could not resolve', () => {
    expect(looksLikeUuidPrefix('fa48af8f2d2e')).toBe(false)
  })

  test('a dash at a non-canonical position is not a prefix', () => {
    // Dash at position 4 (canonical positions are 8, 13, 18, 23)
    expect(looksLikeUuidPrefix('fa48-af8f')).toBe(false)
    // 9th char hex when position 8 should be `-`
    expect(looksLikeUuidPrefix('fa48af8f2')).toBe(false)
  })

  test('the trailing dash forms at canonical positions are valid prefixes (mid-paste shapes)', () => {
    expect(looksLikeUuidPrefix('fa48af8f-')).toBe(true)
    expect(looksLikeUuidPrefix('fa48af8f-2d2e-')).toBe(true)
    expect(looksLikeUuidPrefix('fa48af8f-2d2e-4fd2-')).toBe(true)
    expect(looksLikeUuidPrefix('fa48af8f-2d2e-4fd2-84d5-')).toBe(true)
  })

  test('a 35-char dashed string (one char short of the full canonical UUID) is still a prefix', () => {
    expect(looksLikeUuidPrefix('fa48af8f-2d2e-4fd2-84d5-aa698ed8bb4')).toBe(true)
  })

  test('a codex UUIDv7 (version digit 7 at position 14) is a valid prefix shape — the helper does not gate on version', () => {
    // Position 14 has '7' for UUIDv7 vs '4' for UUIDv4. Both are hex; the helper accepts either.
    expect(looksLikeUuidPrefix('019e5b27-1234-7abc-9def-fedcba98765')).toBe(true)
  })

  test('an empty string is not a prefix', () => {
    expect(looksLikeUuidPrefix('')).toBe(false)
  })

  test('a string with non-hex characters is not a prefix (a teammate name pasted by mistake)', () => {
    expect(looksLikeUuidPrefix('not-a-uuid')).toBe(false)
    expect(looksLikeUuidPrefix('feat-ai-read-dlp-v6')).toBe(false)
    expect(looksLikeUuidPrefix('flow-web-monorepo-2')).toBe(false)
  })

  test('uppercase hex is not a prefix — Claude sids and Codex thread ids are lowercase, so an uppercase paste is more likely a typo than a real id', () => {
    expect(looksLikeUuidPrefix('FA48AF8F')).toBe(false)
  })

  test('dashes only is not a prefix', () => {
    expect(looksLikeUuidPrefix('-')).toBe(false)
    expect(looksLikeUuidPrefix('----')).toBe(false)
  })

  test('hex at or beyond the 32-char UUID body is not a prefix', () => {
    expect(looksLikeUuidPrefix('a'.repeat(32))).toBe(false)
    expect(looksLikeUuidPrefix('a'.repeat(33))).toBe(false)
  })
})
