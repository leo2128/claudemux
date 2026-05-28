/**
 * `readRolloutSessionCwd` extracts the `session_meta.cwd` field from
 * the header of a Codex rollout JSONL. Used by `tm resume <name>
 * <thread-id>` after `tm kill` has removed the identity / Codex
 * meta records: the rollout's recorded cwd is the only durable hint
 * of where the original daemon was launched, so it is what we
 * forward to the resumed daemon instead of letting `cwdForName`
 * fall back to the dispatcher dir.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { readRolloutSessionCwd } from '../../../src/engines/codex/rollout'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync('/tmp/cmx-rollout-cwd-')
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

function writeRollout(lines: readonly string[]): string {
  const path = join(scratch, 'rollout-test.jsonl')
  writeFileSync(path, lines.join('\n') + '\n')
  return path
}

describe('readRolloutSessionCwd', () => {
  test('returns the cwd from the first session_meta line', () => {
    const path = writeRollout([
      JSON.stringify({
        timestamp: '2026-05-08T18:35:43Z',
        type: 'session_meta',
        payload: {
          id: '019e08df-...',
          cwd: '/home/u/repo/.claude/worktrees/auth-7d3a',
          originator: 'codex_exec',
        },
      }),
      JSON.stringify({ type: 'turn_started' }),
    ])
    expect(readRolloutSessionCwd(path)).toBe('/home/u/repo/.claude/worktrees/auth-7d3a')
  })

  test('returns null when no session_meta line is present in the budget window', () => {
    const path = writeRollout([
      JSON.stringify({ type: 'turn_started' }),
      JSON.stringify({ type: 'turn_completed' }),
    ])
    expect(readRolloutSessionCwd(path)).toBeNull()
  })

  test('returns null on an unreadable path', () => {
    expect(readRolloutSessionCwd(join(scratch, 'missing.jsonl'))).toBeNull()
  })

  test('returns null when session_meta has no cwd', () => {
    const path = writeRollout([
      JSON.stringify({ type: 'session_meta', payload: { id: 'abc' } }),
    ])
    expect(readRolloutSessionCwd(path)).toBeNull()
  })

  test('skips blank lines and a malformed first line, still finds the meta', () => {
    const path = writeRollout([
      '',
      'not-json',
      JSON.stringify({
        type: 'session_meta',
        payload: { cwd: '/some/cwd' },
      }),
    ])
    expect(readRolloutSessionCwd(path)).toBe('/some/cwd')
  })

  test('honours the line budget — a meta past the budget is not returned', () => {
    const filler = JSON.stringify({ type: 'turn_started' })
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { cwd: '/late' },
    })
    const path = writeRollout([
      ...Array.from({ length: 10 }, () => filler),
      meta,
    ])
    // Budget 4 lines → the meta on line 10 is invisible.
    expect(readRolloutSessionCwd(path, 4)).toBeNull()
    // Default budget (16) finds it.
    expect(readRolloutSessionCwd(path)).toBe('/late')
  })
})
