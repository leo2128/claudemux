/**
 * `cwdForName` is the cwd-resolution chain that every name-targeted verb
 * relies on (`tm resume`, `tm history`, `tm last`, ...). Decision: after
 * `tm kill` removes the live identity, the verb path must still be able
 * to recover the killed teammate's cwd so that resume/history land on
 * the worktree-encoded project-dir slug rather than the dispatcher's
 * slug. The archive snapshot is the recovery source.
 *
 * Without this fallback, `tm resume <name> <sid>` after a clean kill
 * synthesizes a wrong project-dir path and reports "no transcript at
 * .../<dispatcher-encoded>/<sid>.jsonl", even though the transcript
 * exists at the worktree-encoded slug.
 */

import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { cwdForName, resumeCwdProbeable } from '../../src/cli/parse'
import {
  archive,
  identityFile,
  remove,
  reserve,
} from '../../src/persistence/identity-store'
import { TEAMMATE_RECORD_SCHEMA, type TeammateRecordJson } from '../../src/engines/teammate-record'
import type { NativeEnv } from '../../src/env'

let root: string
let dispatcherDir: string
let savedRoot: string | undefined

beforeEach(() => {
  root = mkdtempSync('/tmp/cmux-cwd-')
  dispatcherDir = mkdtempSync('/tmp/cmux-dispatch-')
  savedRoot = process.env['CLAUDEMUX_IDENTITY_ROOT']
  process.env['CLAUDEMUX_IDENTITY_ROOT'] = root
})

afterEach(() => {
  if (savedRoot === undefined) delete process.env['CLAUDEMUX_IDENTITY_ROOT']
  else process.env['CLAUDEMUX_IDENTITY_ROOT'] = savedRoot
  rmSync(root, { recursive: true, force: true })
  rmSync(dispatcherDir, { recursive: true, force: true })
})

const stubEnv: NativeEnv = {
  // Verb-agnostic stub — `cwdForName` reads only dispatcherDir.
  runTmux: async () => ({ code: 0, stdout: '', stderr: '' }),
  runColumn: async () => ({ code: 0, stdout: '', stderr: '' }),
  runGrep: async () => 1,
  dispatcherDir: '',
  projectsDir: '/tmp/projects',
}

function env(): NativeEnv {
  return { ...stubEnv, dispatcherDir }
}

function record(overrides: Partial<TeammateRecordJson> = {}): TeammateRecordJson {
  return {
    schema: TEAMMATE_RECORD_SCHEMA,
    name: 'alpha',
    engine: 'claude',
    repo: dispatcherDir,
    cwd: dispatcherDir,
    worktreeSlug: null,
    createdAt: 1700000000,
    displayName: null,
    ...overrides,
  }
}

describe('cwdForName archive fallback', () => {
  test('live identity wins over archive — archive is only the post-kill source', () => {
    // A live `alpha` with cwd /live/cwd, plus a stale archive at /old/cwd
    // (the previous kill's snapshot). The live record must take priority.
    const stale = record({ cwd: '/old/cwd' })
    writeFileSync(identityFile('alpha'), JSON.stringify(stale) + '\n')
    archive('alpha')
    remove('alpha')

    expect(reserve(record({ cwd: '/live/cwd' })).kind).toBe('reserved')

    // Path doesn't have to exist on disk — normalizeExistingCwd falls back
    // to the raw value when realpath fails.
    expect(cwdForName('alpha', env())).toBe('/live/cwd')
  })

  test('after kill, cwdForName returns the archived cwd (not dispatcherDir)', () => {
    expect(
      reserve(record({ cwd: '/repo/.claude/worktrees/alpha' })).kind,
    ).toBe('reserved')
    archive('alpha')
    remove('alpha')

    expect(cwdForName('alpha', env())).toBe('/repo/.claude/worktrees/alpha')
  })

  test('with neither live nor archive, falls back to dispatcherDir', () => {
    // Pin the documented last-resort behavior. `cwdForName` runs the
    // value through `realpathSync`, which on macOS resolves
    // `/tmp/...` through `/private/tmp/...`; compare against the
    // resolved form so the test is portable across Linux and macOS.
    expect(cwdForName('ghost', env())).toBe(realpathSync(dispatcherDir))
  })

  test('resumeCwdProbeable is true when only an archive exists', () => {
    expect(reserve(record()).kind).toBe('reserved')
    archive('alpha')
    remove('alpha')

    expect(resumeCwdProbeable('alpha', env())).toBe(true)
  })

  test('resumeCwdProbeable is false when no live record, no archive, no dispatcher child', () => {
    expect(resumeCwdProbeable('ghost', env())).toBe(false)
  })
})
