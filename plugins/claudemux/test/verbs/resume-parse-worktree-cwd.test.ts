/**
 * Coverage for `parseWorktreeCwd` — the helper `tm resume` uses on
 * the checkpoint-reverse branch to recover `repo` + `worktreeSlug`
 * from a rollout's `session_meta.cwd` after `tm kill` has erased the
 * live identity record.
 *
 * The shape contract matters because the Codex engine's
 * resume-after-clean-kill recovery only re-provisions the worktree
 * when it receives a real `worktreeSlug`; getting the split wrong
 * silently falls back to `--no-worktree` mode and the resumed
 * daemon ENOENTs at the deleted worktree path.
 */

import { describe, expect, test } from 'vitest'

import { parseWorktreeCwd } from '../../src/verbs/resume'

describe('parseWorktreeCwd', () => {
  test('splits a standard worktree path into repo + slug', () => {
    expect(parseWorktreeCwd('/home/u/repo/.claude/worktrees/auth-7d3a')).toEqual({
      repo: '/home/u/repo',
      slug: 'auth-7d3a',
    })
  })

  test('tolerates a trailing slash on the worktree path', () => {
    expect(parseWorktreeCwd('/home/u/repo/.claude/worktrees/auth-7d3a/')).toEqual({
      repo: '/home/u/repo',
      slug: 'auth-7d3a',
    })
  })

  test('returns null for a plain repo path (--no-worktree mode)', () => {
    expect(parseWorktreeCwd('/home/u/repo')).toBeNull()
  })

  test('returns null when the suffix has no slug component', () => {
    expect(parseWorktreeCwd('/home/u/repo/.claude/worktrees/')).toBeNull()
    expect(parseWorktreeCwd('/home/u/repo/.claude/worktrees')).toBeNull()
  })

  test('returns null when the path does not contain the .claude/worktrees segment', () => {
    expect(parseWorktreeCwd('/home/u/repo/sub/dir')).toBeNull()
  })

  test('does not match a nested worktree path (`.claude/worktrees/x/y`)', () => {
    // `y` is not a worktree slug; either the shape is invalid or
    // it is a sub-path inside an existing worktree. Either way the
    // recovery code should treat the input as not-a-worktree-cwd.
    expect(parseWorktreeCwd('/home/u/repo/.claude/worktrees/x/y')).toBeNull()
  })

  test('accepts repo paths with dots and hyphens', () => {
    expect(parseWorktreeCwd('/srv/code/flow-web-monorepo/.claude/worktrees/codex-1')).toEqual({
      repo: '/srv/code/flow-web-monorepo',
      slug: 'codex-1',
    })
  })
})
