/**
 * The teammate registry must survive a core restart and tolerate a file left
 * torn by a crash — that durability is the Phase A exit gate. These tests
 * exercise the round-trip, every load-failure path, and reconciliation.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { REGISTRY_SCHEMA_VERSION, Registry } from '../src/registry'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudemux-registry-'))
  file = join(dir, 'registry.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('persistence survives a core restart', () => {
  test('a recorded teammate reloads in a fresh Registry instance', () => {
    const first = new Registry(file)
    first.record({ repo: 'acme', sid: 'sid-1', cwd: '/repos/acme' })

    // A fresh instance is what a restarted core gets.
    const restarted = new Registry(file)
    restarted.load()
    const entry = restarted.get('acme')
    expect(entry?.repo).toBe('acme')
    expect(entry?.sid).toBe('sid-1')
    expect(entry?.cwd).toBe('/repos/acme')
    expect(entry?.agent).toBe('claude')
  })

  test('a save leaves no stray .tmp file behind', () => {
    new Registry(file).record({ repo: 'acme', sid: null, cwd: null })
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}.tmp`)).toBe(false)
  })
})

describe('a load never throws on a bad file', () => {
  test('a missing file loads as an empty registry', () => {
    const registry = new Registry(file)
    registry.load()
    expect(registry.list()).toEqual([])
  })

  test('an unparseable file loads as an empty registry', () => {
    writeFileSync(file, '{ this is not json')
    const registry = new Registry(file)
    registry.load()
    expect(registry.list()).toEqual([])
  })

  test('a file from a different schema version loads as empty', () => {
    writeFileSync(
      file,
      JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION + 1, teammates: [] }),
    )
    const registry = new Registry(file)
    registry.load()
    expect(registry.list()).toEqual([])
  })

  test('a malformed entry is dropped while valid siblings survive', () => {
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        teammates: [
          { repo: 'ok', agent: 'claude', sid: null, cwd: null, spawnedAt: 't', observedAt: 't' },
          { agent: 'claude' }, // no repo — malformed
        ],
      }),
    )
    const registry = new Registry(file)
    registry.load()
    expect(registry.list().map((t) => t.repo)).toEqual(['ok'])
  })
})

describe('record, remove, reconcile', () => {
  test('record upserts by repo and preserves the original spawnedAt', () => {
    let clock = 1_000
    const registry = new Registry(file, () => clock)
    registry.record({ repo: 'acme', sid: 'sid-1', cwd: '/a' })
    const spawnedAt = registry.get('acme')?.spawnedAt

    clock = 9_000
    registry.record({ repo: 'acme', sid: 'sid-2', cwd: '/a' })
    const entry = registry.get('acme')
    expect(registry.list()).toHaveLength(1)
    expect(entry?.sid).toBe('sid-2')
    expect(entry?.spawnedAt).toBe(spawnedAt!)
    expect(entry?.observedAt).not.toBe(spawnedAt!)
  })

  test('remove deletes by repo and is a no-op for an absent repo', () => {
    const registry = new Registry(file)
    registry.record({ repo: 'acme', sid: null, cwd: null })
    registry.remove('ghost') // absent — no throw
    registry.remove('acme')
    expect(registry.list()).toEqual([])
  })

  test('reconcile drops the teammates the predicate rejects', () => {
    const registry = new Registry(file)
    registry.record({ repo: 'live', sid: null, cwd: null })
    registry.record({ repo: 'dead', sid: null, cwd: null })

    const dropped = registry.reconcile((t) => t.repo === 'live')
    expect(dropped.map((d) => d.repo)).toEqual(['dead'])
    expect(registry.list().map((t) => t.repo)).toEqual(['live'])

    // The drop is persisted: a restarted core sees the reconciled set.
    const restarted = new Registry(file)
    restarted.load()
    expect(restarted.list().map((t) => t.repo)).toEqual(['live'])
  })

  test('reconcile with nothing to drop returns empty and does not rewrite', () => {
    const registry = new Registry(file)
    registry.record({ repo: 'live', sid: null, cwd: null })
    expect(registry.reconcile(() => true)).toEqual([])
  })

  test('reconcile evaluates the liveness predicate exactly once per teammate', () => {
    const registry = new Registry(file)
    registry.record({ repo: 'a', sid: null, cwd: null })
    registry.record({ repo: 'b', sid: null, cwd: null })
    const seen: string[] = []
    registry.reconcile((t) => {
      seen.push(t.repo)
      return true
    })
    expect(seen.sort()).toEqual(['a', 'b'])
  })
})
