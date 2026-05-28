/**
 * Coverage for `provisionCodexWorktree` / `reapCodexWorktree` —
 * specifically that a clean `provision → reap → provision` round-trip
 * does not leak the `worktree-<slug>` branch. `git worktree remove`
 * leaves the branch behind by default, so a second `tm spawn` with
 * the same `--name` used to fail with `branch already exists`.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  provisionCodexWorktree,
  reapCodexWorktree,
} from '../../src/engines/git-worktree'
import { spawnCapture } from '../../src/proc'

let scratch: string
let repo: string

async function git(...args: string[]): Promise<string> {
  const result = await spawnCapture(['git', '-C', repo, ...args])
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.code}): ${result.stderr}`)
  }
  return result.stdout
}

beforeEach(async () => {
  scratch = mkdtempSync('/tmp/cmx-wt-test-')
  repo = join(scratch, 'repo')
  mkdirSync(repo)
  // Pre-seed a minimum-viable git repo so `worktree add -b ... HEAD`
  // has a HEAD to fork from. `init -q` keeps test output clean.
  await spawnCapture(['git', '-C', repo, 'init', '-q', '-b', 'main'])
  await spawnCapture(['git', '-C', repo, 'config', 'user.email', 'test@test'])
  await spawnCapture(['git', '-C', repo, 'config', 'user.name', 'test'])
  writeFileSync(join(repo, 'README'), 'seed\n')
  await spawnCapture(['git', '-C', repo, 'add', 'README'])
  await spawnCapture(['git', '-C', repo, 'commit', '-q', '-m', 'seed'])
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('Codex worktree provision / reap', () => {
  test('reap removes both the worktree path and the worktree-<slug> branch', async () => {
    const slug = 'feature-x'
    const provisionError = await provisionCodexWorktree(repo, slug)
    expect(provisionError).toBeNull()

    const branchesBefore = await git('branch', '--list', 'worktree-feature-x')
    expect(branchesBefore.trim()).toContain('worktree-feature-x')

    const reap = await reapCodexWorktree(repo, slug)
    expect(reap.kind).toBe('removed')

    const branchesAfter = await git('branch', '--list', 'worktree-feature-x')
    expect(branchesAfter.trim()).toBe('')
  })

  test('a second provision with the same slug after reap succeeds (the round-trip)', async () => {
    const slug = 'feature-y'
    expect(await provisionCodexWorktree(repo, slug)).toBeNull()
    expect((await reapCodexWorktree(repo, slug)).kind).toBe('removed')
    // Without the branch cleanup in `reapCodexWorktree`, this call
    // would die with `fatal: a branch named 'worktree-feature-y' already exists`.
    const second = await provisionCodexWorktree(repo, slug)
    expect(second).toBeNull()
  })

  test('reap is a no-op when the worktree path is gone', async () => {
    const slug = 'never-provisioned'
    const reap = await reapCodexWorktree(repo, slug)
    expect(reap.kind).toBe('not-present')
  })

  test('provision after clean reap re-creates the worktree path — the Codex resume recovery shape', async () => {
    // This is the shape the Codex engine's resume-after-clean-kill
    // recovery relies on: `tm kill` removed the worktree path, then
    // `tm resume <name> <thread-id>` parses the rollout cwd into
    // repo + slug and asks `provisionCodexWorktree` to materialise
    // the directory back so `spawnDaemon`'s cwd actually exists.
    const slug = 'resume-recovery'
    const wt = join(repo, '.claude/worktrees/resume-recovery')
    expect(await provisionCodexWorktree(repo, slug)).toBeNull()
    expect(existsSync(wt)).toBe(true)
    expect((await reapCodexWorktree(repo, slug)).kind).toBe('removed')
    expect(existsSync(wt)).toBe(false)
    expect(await provisionCodexWorktree(repo, slug)).toBeNull()
    expect(existsSync(wt)).toBe(true)
  })

  test('reap preserves a dirty worktree and reports preserved-dirty', async () => {
    const slug = 'dirty-slug'
    expect(await provisionCodexWorktree(repo, slug)).toBeNull()
    // Mutate the worktree so `git status --porcelain` reports work.
    writeFileSync(join(repo, '.claude/worktrees/dirty-slug/SCRATCH'), 'wip\n')
    const reap = await reapCodexWorktree(repo, slug)
    expect(reap.kind).toBe('preserved-dirty')
    // Branch survives — the user has not consented to losing the work.
    const branches = await git('branch', '--list', 'worktree-dirty-slug')
    expect(branches.trim()).toContain('worktree-dirty-slug')
  })

  test('reap preserves a clean worktree whose branch carries unmerged commits, restores the path, reports preserved-unmerged', async () => {
    const slug = 'committed-slug'
    expect(await provisionCodexWorktree(repo, slug)).toBeNull()
    const wt = join(repo, '.claude/worktrees/committed-slug')
    // Commit a file inside the worktree so the branch tip diverges from
    // HEAD. `git status --porcelain` is empty afterwards (the working
    // tree is clean), but the branch carries work not in the parent.
    writeFileSync(join(wt, 'feature.ts'), 'export const value = 1\n')
    await spawnCapture(['git', '-C', wt, 'add', 'feature.ts'])
    await spawnCapture(['git', '-C', wt, 'commit', '-q', '-m', 'feature commit'])

    const reap = await reapCodexWorktree(repo, slug)
    expect(reap.kind).toBe('preserved-unmerged')

    // Worktree path is restored (kill removed it, the unmerged-branch
    // guard re-created it so the user can resume).
    expect(existsSync(wt)).toBe(true)

    // Branch survives — and crucially the commit is still reachable
    // via the ref (the previous `-D` would have left a dangling
    // commit recoverable only via reflog / fsck).
    const branches = await git('branch', '--list', 'worktree-committed-slug')
    expect(branches.trim()).toContain('worktree-committed-slug')
    const log = await git('log', '--format=%s', 'worktree-committed-slug', '-1')
    expect(log.trim()).toBe('feature commit')
  })
})
