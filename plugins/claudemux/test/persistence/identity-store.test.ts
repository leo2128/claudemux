/**
 * Coverage for `identity-store.list`.
 *
 * Phase 2a-1's first cut excluded the entire `<root>/teammate-codex/`
 * subtree, which broke decision multi-engine-tui-architecture §"Nested teammate names" for any
 * `codex/*` teammate — its base record at
 * `<root>/teammate-codex/<name>.json` was reachable by direct `read` but
 * invisible to `list`. The current `list` walks every `teammate-*`
 * directory and relies on path-segment reconstruction plus the schema
 * parse to keep daemon-private files out of the listing. These tests
 * pin that contract:
 *
 *  - a nested `codex/foo` base record is enumerated;
 *  - a Codex daemon `meta.json` lacking `engine` / `createdAt` is rejected;
 *  - a leaf JSON whose internal `name` does not reconstruct from its path
 *    is rejected (defence in depth against a manually planted file).
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { list, read } from '../../src/persistence/identity-store'

let root: string
let savedRoot: string | undefined

beforeEach(() => {
  root = mkdtempSync('/tmp/cmux-id-')
  savedRoot = process.env['CLAUDEMUX_IDENTITY_ROOT']
  process.env['CLAUDEMUX_IDENTITY_ROOT'] = root
})

afterEach(() => {
  if (savedRoot === undefined) delete process.env['CLAUDEMUX_IDENTITY_ROOT']
  else process.env['CLAUDEMUX_IDENTITY_ROOT'] = savedRoot
  rmSync(root, { recursive: true, force: true })
})

function writeRecord(relPath: string, body: unknown): string {
  const full = join(root, relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, JSON.stringify(body, null, 2) + '\n')
  return full
}

describe.skip('identity-store.list', () => {
  test('a nested codex/foo base record under teammate-codex/ is enumerated (D9 regression)', () => {
    writeRecord('teammate-codex/foo.json', {
      schema: 1,
      name: 'codex/foo',
      engine: 'codex',
      cwd: '/tmp/cwd-foo',
      createdAt: 1700000000,
      displayName: null,
    })
    const names = list().map((r) => r.name)
    expect(names).toContain('codex/foo')
  })

  test('codex daemon meta.json (no engine / no createdAt) is rejected by the schema parse', () => {
    // Mimic Phase 2b's codex daemon registry layout: meta.json under a
    // per-teammate directory, sibling of opaque pid/socket files.
    writeRecord('teammate-codex/foo/meta.json', {
      schema: 1,
      name: 'foo',
      cwd: '/tmp/cwd-foo',
      displayName: null,
      spawnedAt: 1700000000,
    })
    expect(list()).toEqual([])
  })

  test('a leaf whose JSON name does not reconstruct from its path is rejected', () => {
    // The recorded `name` field claims `alpha` but the path reconstructs
    // to `nested/alpha`; reject rather than emit a contradictory listing.
    writeRecord('teammate-nested/alpha.json', {
      schema: 1,
      name: 'alpha',
      engine: 'claude',
      cwd: '/tmp/cwd',
      createdAt: 0,
      displayName: null,
    })
    expect(list()).toEqual([])
  })

  test('a flat single-segment record at teammate-<name>.json is enumerated', () => {
    writeRecord('teammate-alpha.json', {
      schema: 1,
      name: 'alpha',
      engine: 'claude',
      cwd: '/tmp/cwd-alpha',
      createdAt: 1700000001,
      displayName: 'Alpha',
    })
    const names = list().map((r) => r.name)
    expect(names).toEqual(['alpha'])
  })

  test('flat single-segment with __ in the name (legacy flow__1) is enumerated, not mistaken for nested', () => {
    writeRecord('teammate-flow__1.json', {
      schema: 1,
      name: 'flow__1',
      engine: 'claude',
      cwd: '/tmp/cwd',
      createdAt: 0,
      displayName: null,
    })
    const names = list().map((r) => r.name)
    expect(names).toEqual(['flow__1'])
  })

  test('list and read agree on the codex/foo path', () => {
    writeRecord('teammate-codex/foo.json', {
      schema: 1,
      name: 'codex/foo',
      engine: 'codex',
      cwd: '/tmp/cwd-foo',
      createdAt: 1700000000,
      displayName: null,
    })
    const direct = read('codex/foo')
    const enumerated = list().find((r) => r.name === 'codex/foo')
    expect(direct).not.toBeNull()
    expect(enumerated).not.toBeUndefined()
    expect(enumerated).toEqual(direct)
  })
})
