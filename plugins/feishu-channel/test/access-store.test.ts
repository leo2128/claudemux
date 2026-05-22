import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultAccess, loadAccess, normalizeAccess, saveAccess } from '../src/access-store'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'feishu-store-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('loadAccess', () => {
  test('a missing file yields defaults and is not flagged corrupt', () => {
    const r = loadAccess(join(dir, 'access.json'))
    expect(r.corrupt).toBe(false)
    expect(r.access).toEqual(defaultAccess())
  })

  test('round-trips a saved file', () => {
    const file = join(dir, 'access.json')
    const access = {
      ...defaultAccess(),
      dmPolicy: 'allowlist' as const,
      allowFrom: ['ou_a', 'ou_b'],
    }
    saveAccess(file, access)
    expect(loadAccess(file).access).toEqual(access)
  })

  test('moves an unparseable file aside and starts from defaults', () => {
    const file = join(dir, 'access.json')
    writeFileSync(file, '{ this is not json')
    const r = loadAccess(file)
    expect(r.corrupt).toBe(true)
    expect(r.access).toEqual(defaultAccess())
    const moved = readdirSync(dir).filter((f) => f.startsWith('access.json.corrupt-'))
    expect(moved).toHaveLength(1)
  })

  test('fills defaults for a partial file', () => {
    const file = join(dir, 'access.json')
    writeFileSync(file, JSON.stringify({ dmPolicy: 'allowlist' }))
    const r = loadAccess(file)
    expect(r.corrupt).toBe(false)
    expect(r.access).toEqual({
      dmPolicy: 'allowlist',
      groupPolicy: 'allowlist',
      allowFrom: [],
      groups: {},
      pending: {},
    })
  })
})

describe('saveAccess', () => {
  test('creates parent directories owner-only', () => {
    const nested = join(dir, 'channels', 'feishu')
    const file = join(nested, 'access.json')
    saveAccess(file, defaultAccess())
    expect(statSync(nested).mode & 0o077).toBe(0)
  })

  test('writes the file owner-only', () => {
    const file = join(dir, 'access.json')
    saveAccess(file, defaultAccess())
    expect(statSync(file).mode & 0o077).toBe(0)
  })

  test('leaves no temp file behind', () => {
    const file = join(dir, 'access.json')
    saveAccess(file, defaultAccess())
    expect(readdirSync(dir)).toEqual(['access.json'])
  })

  test('writes pretty-printed JSON with a trailing newline', () => {
    const file = join(dir, 'access.json')
    saveAccess(file, defaultAccess())
    const raw = readFileSync(file, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw).toContain('\n  ')
  })
})

describe('normalizeAccess', () => {
  test('non-object input becomes a default access', () => {
    expect(normalizeAccess(null)).toEqual(defaultAccess())
    expect(normalizeAccess('nope')).toEqual(defaultAccess())
  })

  test('an invalid dmPolicy falls back to the default', () => {
    expect(normalizeAccess({ dmPolicy: 'bogus' }).dmPolicy).toBe('pairing')
  })

  test('a missing or invalid groupPolicy falls back to allowlist', () => {
    expect(normalizeAccess({}).groupPolicy).toBe('allowlist')
    expect(normalizeAccess({ groupPolicy: 'bogus' }).groupPolicy).toBe('allowlist')
  })

  test('a valid groupPolicy is kept', () => {
    expect(normalizeAccess({ groupPolicy: 'block' }).groupPolicy).toBe('block')
    expect(normalizeAccess({ groupPolicy: 'follow-user' }).groupPolicy).toBe('follow-user')
  })

  test('an access.json predating groupPolicy loads with the allowlist default', () => {
    // A file written before this field existed keeps the decision-0010
    // behavior: groups and any group-kind pending entry survive unchanged.
    const a = normalizeAccess({
      dmPolicy: 'pairing',
      allowFrom: ['ou_a'],
      groups: { oc_g: { requireMention: true, allowFrom: [] } },
      pending: { code: { senderId: 'ou_b', kind: 'group', chatId: 'oc_g' } },
    })
    expect(a.groupPolicy).toBe('allowlist')
    expect(a.groups['oc_g']).toEqual({ requireMention: true, allowFrom: [] })
    expect(a.pending['code']?.kind).toBe('group')
  })

  test('non-string allowFrom entries are filtered out', () => {
    expect(normalizeAccess({ allowFrom: ['ou_a', 42, null, 'ou_b'] }).allowFrom).toEqual([
      'ou_a',
      'ou_b',
    ])
  })

  test('group entries get a default requireMention of true', () => {
    const groups = normalizeAccess({ groups: { oc_1: {} } }).groups
    expect(groups['oc_1']).toEqual({ requireMention: true, allowFrom: [] })
  })

  test('a pending entry with no sender id is dropped', () => {
    const pending = normalizeAccess({
      pending: { good: { senderId: 'ou_a' }, bad: { chatId: 'oc_x' } },
    }).pending
    expect(Object.keys(pending)).toEqual(['good'])
    expect(pending['good']?.replies).toBe(1)
  })

  test('a pending entry without a kind defaults to a dm request', () => {
    const pending = normalizeAccess({ pending: { c: { senderId: 'ou_a' } } }).pending
    expect(pending['c']?.kind).toBe('dm')
  })

  test('a group pending entry keeps its kind; a bogus kind falls back to dm', () => {
    const pending = normalizeAccess({
      pending: {
        grp: { senderId: 'ou_a', kind: 'group' },
        bog: { senderId: 'ou_b', kind: 'nonsense' },
      },
    }).pending
    expect(pending['grp']?.kind).toBe('group')
    expect(pending['bog']?.kind).toBe('dm')
  })
})
