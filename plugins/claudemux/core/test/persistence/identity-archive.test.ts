/**
 * Coverage for the post-kill identity archive — the snapshot `tm kill`
 * leaves behind so a later `tm resume <name> <sid>` or
 * `tm history <name>` can recover the killed teammate's launch
 * context (cwd / repo / worktreeSlug / displayName) without the
 * agent reading `/tmp/teammate-*.json` files by hand.
 *
 * The archive lives at `<CLAUDEMUX_IDENTITY_ROOT>/teammate-archive/<name>.json`.
 * Its shape is the same `TeammateRecordJson` the live record carries;
 * its lifecycle is decoupled from the live file:
 *
 *  - `archive(name)` snapshots the live record into the archive
 *    directory iff a live record exists. It is the only mutation `tm
 *    kill` performs *before* `remove(name)` clears the live JSON.
 *  - `readArchived(name)` returns the snapshot for `name`, or `null`
 *    when the name was never killed (or `removeArchived` cleared
 *    the snapshot).
 *  - The archive directory must not pollute `list()` — `tm ls` walks
 *    the live directory and would otherwise re-surface every killed
 *    teammate as a phantom listing.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  archive,
  archivedIdentityFile,
  identityFile,
  list,
  read,
  readArchived,
  remove,
  removeArchived,
  reserve,
} from '../../src/persistence/identity-store'
import { TEAMMATE_RECORD_SCHEMA, type TeammateRecordJson } from '../../src/engines/teammate-record'

let root: string
let savedRoot: string | undefined

beforeEach(() => {
  root = mkdtempSync('/tmp/cmux-arc-')
  savedRoot = process.env['CLAUDEMUX_IDENTITY_ROOT']
  process.env['CLAUDEMUX_IDENTITY_ROOT'] = root
})

afterEach(() => {
  if (savedRoot === undefined) delete process.env['CLAUDEMUX_IDENTITY_ROOT']
  else process.env['CLAUDEMUX_IDENTITY_ROOT'] = savedRoot
  rmSync(root, { recursive: true, force: true })
})

function sampleRecord(overrides: Partial<TeammateRecordJson> = {}): TeammateRecordJson {
  return {
    schema: TEAMMATE_RECORD_SCHEMA,
    name: 'alpha',
    engine: 'claude',
    repo: '/home/u/repo',
    cwd: '/home/u/repo/.claude/worktrees/alpha',
    worktreeSlug: 'alpha',
    createdAt: 1700000000,
    displayName: null,
    ...overrides,
  }
}

describe('identity-store archive', () => {
  test('archive snapshots the live record into the archive directory', () => {
    const record = sampleRecord()
    expect(reserve(record).kind).toBe('reserved')

    expect(archive('alpha')).toBe(true)

    expect(readArchived('alpha')).toEqual(record)
    expect(archivedIdentityFile('alpha')).toBe(join(root, 'teammate-archive', 'alpha.json'))
  })

  test('archive is a no-op when no live record exists', () => {
    expect(archive('ghost')).toBe(false)
    expect(readArchived('ghost')).toBeNull()
  })

  test('archive then remove leaves only the archive — the live JSON is gone', () => {
    expect(reserve(sampleRecord()).kind).toBe('reserved')
    archive('alpha')
    remove('alpha')

    expect(read('alpha')).toBeNull()
    expect(readArchived('alpha')).not.toBeNull()
  })

  test('the archive directory is not enumerated by list()', () => {
    const live = sampleRecord({ name: 'live-one' })
    expect(reserve(live).kind).toBe('reserved')

    // Plant an archive snapshot for a *different* name that has no
    // live record. `list()` must not return this as a phantom teammate.
    const archived = sampleRecord({ name: 'killed-one' })
    writeFileSync(identityFile('killed-one'), JSON.stringify(archived) + '\n')
    archive('killed-one')
    remove('killed-one')

    const names = list().map((r) => r.name).sort()
    expect(names).toEqual(['live-one'])
  })

  test('archive overwrites the previous snapshot when the same name is killed again', () => {
    const first = sampleRecord({ cwd: '/old/cwd' })
    expect(reserve(first).kind).toBe('reserved')
    archive('alpha')
    remove('alpha')

    const second = sampleRecord({ cwd: '/new/cwd' })
    expect(reserve(second).kind).toBe('reserved')
    archive('alpha')

    expect(readArchived('alpha')?.cwd).toBe('/new/cwd')
  })

  test('removeArchived clears the snapshot; subsequent reads return null', () => {
    expect(reserve(sampleRecord()).kind).toBe('reserved')
    archive('alpha')
    expect(readArchived('alpha')).not.toBeNull()

    removeArchived('alpha')
    expect(readArchived('alpha')).toBeNull()
  })

  test('removeArchived is idempotent when no snapshot exists', () => {
    expect(() => removeArchived('never-existed')).not.toThrow()
  })

  test('archived record round-trips every field — cwd, repo, worktreeSlug, displayName', () => {
    const record = sampleRecord({
      name: 'beta',
      engine: 'codex',
      repo: '/srv/code/flow',
      cwd: '/srv/code/flow/.claude/worktrees/beta',
      worktreeSlug: 'beta',
      displayName: 'Beta Worker',
      createdAt: 1717000000,
    })
    expect(reserve(record).kind).toBe('reserved')
    archive('beta')

    expect(readArchived('beta')).toEqual(record)
  })
})
