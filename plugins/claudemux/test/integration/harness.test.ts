/**
 * Unit tests for the live-teammate harness's pure pieces.
 *
 * These cover the `~/.claude.json` trust transforms — the part of the harness
 * that mutates a shared user file, so it must be exact — without spawning a
 * teammate. They are a normal `*.test.ts`, so `npm test` (and CI) runs them;
 * the live suite that needs a real `claude` is `*.itest.ts` under its own
 * config and is never picked up here.
 */

import { describe, expect, test } from 'vitest'

import { claudeJsonPath, withoutProjectPaths, withTrustedPaths } from './harness'

describe('withTrustedPaths', () => {
  test('marks a fresh path trusted, creating the projects map', () => {
    const result = withTrustedPaths({}, ['/tmp/itest/a'])
    expect(result.projects).toEqual({
      '/tmp/itest/a': { hasTrustDialogAccepted: true },
    })
  })

  test('preserves the other fields of an existing project entry', () => {
    const input = {
      projects: { '/tmp/itest/a': { lastCost: 0.42, hasTrustDialogAccepted: false } },
    }
    const result = withTrustedPaths(input, ['/tmp/itest/a'])
    expect(result.projects?.['/tmp/itest/a']).toEqual({
      lastCost: 0.42,
      hasTrustDialogAccepted: true,
    })
  })

  test('preserves unrelated projects and top-level keys', () => {
    const input = {
      userID: 'u1',
      projects: { '/home/real/repo': { hasTrustDialogAccepted: true } },
    }
    const result = withTrustedPaths(input, ['/tmp/itest/a'])
    expect(result.userID).toBe('u1')
    expect(result.projects?.['/home/real/repo']).toEqual({ hasTrustDialogAccepted: true })
    expect(result.projects?.['/tmp/itest/a']).toEqual({ hasTrustDialogAccepted: true })
  })

  test('seeds every path when given several', () => {
    const result = withTrustedPaths({}, ['/tmp/itest/a', '/tmp/itest/b'])
    expect(Object.keys(result.projects ?? {})).toEqual(['/tmp/itest/a', '/tmp/itest/b'])
  })

  test('does not mutate the input object', () => {
    const input = { projects: { '/tmp/itest/a': {} } }
    withTrustedPaths(input, ['/tmp/itest/a'])
    expect(input.projects['/tmp/itest/a']).toEqual({})
  })
})

describe('withoutProjectPaths', () => {
  test('removes the given project entry entirely', () => {
    const input = { projects: { '/tmp/itest/a': { hasTrustDialogAccepted: true } } }
    const result = withoutProjectPaths(input, ['/tmp/itest/a'])
    expect(result.projects).toEqual({})
  })

  test('leaves unrelated project entries untouched', () => {
    const input = {
      projects: {
        '/tmp/itest/a': { hasTrustDialogAccepted: true },
        '/home/real/repo': { lastCost: 1 },
      },
    }
    const result = withoutProjectPaths(input, ['/tmp/itest/a'])
    expect(result.projects).toEqual({ '/home/real/repo': { lastCost: 1 } })
  })

  test('is a no-op for a path that is not present', () => {
    const input = { projects: { '/home/real/repo': {} } }
    const result = withoutProjectPaths(input, ['/tmp/itest/gone'])
    expect(result.projects).toEqual({ '/home/real/repo': {} })
  })

  test('tolerates a missing projects map', () => {
    const result = withoutProjectPaths({ userID: 'u1' }, ['/tmp/itest/a'])
    expect(result).toEqual({ userID: 'u1', projects: {} })
  })

  test('does not mutate the input object', () => {
    const input = { projects: { '/tmp/itest/a': { hasTrustDialogAccepted: true } } }
    withoutProjectPaths(input, ['/tmp/itest/a'])
    expect(input.projects['/tmp/itest/a']).toEqual({ hasTrustDialogAccepted: true })
  })
})

describe('claudeJsonPath', () => {
  test('is an absolute path ending in .claude.json', () => {
    const path = claudeJsonPath()
    expect(path.startsWith('/')).toBe(true)
    expect(path.endsWith('/.claude.json')).toBe(true)
  })
})
