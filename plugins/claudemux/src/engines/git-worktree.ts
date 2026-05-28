/**
 * Self-managed git worktree helpers — used by engines (currently
 * Codex) that do not have a native worktree concept.
 *
 * The Claude engine relies on `claude --worktree <slug>` and does not
 * call into this module. Codex has no equivalent flag, so claudemux
 * drives `git worktree add` / `git worktree remove` itself; the
 * resulting worktree layout matches Claude's:
 *
 *     <repo>/.claude/worktrees/<slug>     ← runtime cwd
 *     branch: worktree-<slug>             ← matches `claude --worktree`
 *
 * Decisions:
 *
 *   - `baseRef = HEAD`. The user's pinned default for both engines;
 *     Claude's side configures this through its `--settings` worktree
 *     block, ours is just `git worktree add -b worktree-<slug> <path>
 *     HEAD`.
 *
 *   - `--no-worktree` does not call these helpers; the daemon's cwd
 *     stays at the repo root.
 */

import { existsSync } from 'node:fs'

import { spawnCapture } from '../proc'
import { worktreeBranchFor, worktreePathFor } from '../persistence/paths'

/**
 * Create the worktree for a Codex teammate. Returns `null` on
 * success, or a human-readable error message describing why the
 * `git worktree add` invocation failed.
 *
 * Idempotent: a worktree-path that already exists is accepted —
 * either the previous spawn left a clean directory or the user
 * pre-created it via `claude --worktree <slug>` from the same repo.
 */
export async function provisionCodexWorktree(
  repo: string,
  slug: string,
): Promise<string | null> {
  const path = worktreePathFor(repo, slug)
  if (existsSync(path)) return null
  const branch = worktreeBranchFor(slug)
  const args = ['git', '-C', repo, 'worktree', 'add', '-b', branch, path, 'HEAD']
  const result = await spawnCapture(args)
  if (result.code === 0) return null
  return (
    `git worktree add failed (code ${result.code}): ` +
    (result.stderr.trim() || result.stdout.trim() || `unknown failure running ${args.join(' ')}`)
  )
}

/**
 * Tear down the worktree for a Codex teammate. Returns the
 * resolution:
 *
 *  - `removed` — the worktree was cleanly cleared AND the
 *    `worktree-<slug>` branch was removable (either fully merged
 *    into the parent HEAD or already gone elsewhere).
 *  - `preserved-dirty` — `git status --porcelain` reported uncommitted
 *    changes; the worktree and the branch are both kept.
 *  - `preserved-unmerged` — the worktree itself had no uncommitted
 *    changes, but its branch carries commits that are not merged
 *    into the parent HEAD. The worktree was removed (its content
 *    is reachable via the surviving branch ref); the branch is
 *    preserved so the user's committed work does not become a
 *    dangling object.
 *  - `not-present` — nothing to remove.
 *  - `failed` — some `git` invocation failed.
 */
export type CodexWorktreeReap =
  | { kind: 'removed' }
  | { kind: 'preserved-dirty'; path: string }
  | { kind: 'preserved-unmerged'; path: string; branch: string }
  | { kind: 'not-present' }
  | { kind: 'failed'; message: string }

export async function reapCodexWorktree(
  repo: string,
  slug: string,
): Promise<CodexWorktreeReap> {
  const path = worktreePathFor(repo, slug)
  if (!existsSync(path)) return { kind: 'not-present' }
  const status = await spawnCapture(['git', '-C', path, 'status', '--porcelain'])
  if (status.code !== 0) {
    return {
      kind: 'failed',
      message:
        `git status failed (code ${status.code}): ${status.stderr.trim() || status.stdout.trim()}`,
    }
  }
  if (status.stdout.trim().length > 0) {
    return { kind: 'preserved-dirty', path }
  }
  const remove = await spawnCapture(['git', '-C', repo, 'worktree', 'remove', '--force', path])
  if (remove.code !== 0) {
    return {
      kind: 'failed',
      message:
        `git worktree remove failed (code ${remove.code}): ${remove.stderr.trim() || remove.stdout.trim()}`,
    }
  }
  // `provisionCodexWorktree` created the branch with `worktree add
  // -b worktree-<slug>`; `git worktree remove` does NOT delete the
  // branch ref. Use `git branch -d` (safe) — it refuses to delete a
  // branch carrying commits not yet merged into HEAD, which is
  // exactly the case where a force-delete would orphan committed
  // user work into a dangling commit. On `-d` refusal, restore the
  // worktree path (so the user can resume the conversation /
  // recover from the branch) and report `preserved-unmerged`. If
  // `-d` succeeds (branch was merged or already gone), the slug
  // is now fully free for a subsequent same-name `tm spawn`.
  const branch = worktreeBranchFor(slug)
  const branchDelete = await spawnCapture(['git', '-C', repo, 'branch', '-d', branch])
  if (branchDelete.code === 0) return { kind: 'removed' }
  const stderr = branchDelete.stderr.trim()
  // `not fully merged` is what `git branch -d` prints when refusing
  // because of unmerged commits. If git failed for any *other*
  // reason (e.g. the branch was already gone), the slug is still
  // free, so treat it the same as `removed`.
  if (!/not fully merged/i.test(stderr)) return { kind: 'removed' }
  // The branch ref carries unmerged work. Recreate the worktree
  // pointing back at it so the user can recover. If even this
  // restore fails, the data is still safe at the branch ref — but
  // we surface a `failed` so the user can intervene.
  const restore = await spawnCapture(['git', '-C', repo, 'worktree', 'add', path, branch])
  if (restore.code !== 0) {
    return {
      kind: 'failed',
      message:
        `branch '${branch}' has unmerged commits and the recovery worktree-restore failed: ` +
        (restore.stderr.trim() || restore.stdout.trim()),
    }
  }
  return { kind: 'preserved-unmerged', path, branch }
}
