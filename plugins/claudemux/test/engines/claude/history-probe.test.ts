/**
 * Boundary coverage for `hasClaudeHistoryForCwd` — the existence-only
 * candidate check the resume-probing branch in `verbs/resume.ts` calls.
 * The contract is intentionally shallow (any `.jsonl` file under the
 * cwd's encoded project dir counts), to mirror `hasCodexHistoryForCwd`
 * and avoid the two engines disagreeing on what "has candidate" means
 * — that disagreement would silently bias the ambiguity decision.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { hasClaudeHistoryForCwd } from '../../../src/engines/claude/history'
import { encodeProjectDir } from '../../../src/persistence/paths'

let projectsDir: string
let cwd: string
let projectDir: string

beforeEach(() => {
  projectsDir = mkdtempSync('/tmp/cmx-claude-probe-')
  cwd = mkdtempSync('/tmp/cmx-claude-cwd-')
  projectDir = join(projectsDir, encodeProjectDir(cwd))
})

afterEach(() => {
  rmSync(projectsDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

describe('hasClaudeHistoryForCwd', () => {
  test('returns false when the encoded project dir does not exist', () => {
    // Probing must not crash on a fresh cwd; the dir is created lazily
    // by Claude Code on first session, so "missing" is the common case.
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(false)
  })

  test('returns false when the project dir exists but is empty', () => {
    mkdirSync(projectDir, { recursive: true })
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(false)
  })

  test('returns true for a zero-byte .jsonl — claude --continue picks it', () => {
    // The existence-only contract: an empty jsonl is still a candidate
    // claude --continue could pick. Anything stricter would diverge from
    // hasCodexHistoryForCwd, which also accepts a present-but-empty
    // rollout (first-line cwd missing is treated the same as no record,
    // but a present file with a matching cwd is true even when the file
    // itself has no useful turns).
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, '00000000-0000-0000-0000-000000000000.jsonl'), '')
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(true)
  })

  test('returns true even when every jsonl is malformed', () => {
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'a.jsonl'), 'not-json-at-all\n{"broken":\n')
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(true)
  })

  test('returns false when only non-jsonl files are present', () => {
    // The marker the SessionStart hook writes (e.g. *.sid) lives elsewhere
    // (/tmp/claude-idle), but a future stray file under projects/ must not
    // false-positive as a transcript.
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'README.md'), '#\n')
    writeFileSync(join(projectDir, 'notes.txt'), 'x\n')
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(false)
  })

  test('returns true when any single .jsonl is present alongside other files', () => {
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'unrelated.log'), '\n')
    writeFileSync(join(projectDir, 'session.jsonl'), '\n')
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(true)
  })

  test('returns false when projectsDir itself is missing on disk', () => {
    rmSync(projectsDir, { recursive: true, force: true })
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(false)
  })

  test('keys lookup by encoded cwd, not raw cwd', () => {
    // Sanity: if encodeProjectDir is bypassed (e.g. a future caller
    // forgets the encoding) the lookup misses. Pinning the encoded path
    // guards the routing through the one canonical encoder.
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'a.jsonl'), '')
    expect(hasClaudeHistoryForCwd(cwd, projectsDir)).toBe(true)
    // A different cwd encodes to a different dir → miss.
    const other = `${cwd}-not-here`
    expect(hasClaudeHistoryForCwd(other, projectsDir)).toBe(false)
  })
})
