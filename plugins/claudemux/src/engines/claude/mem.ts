/**
 * Claude-engine `tm mem` body — print a teammate's Claude Code
 * project memory index (`MEMORY.md` under
 * `~/.claude/projects/<dir>/memory/`).
 *
 * Schema 2 lookup: the AutoMemory directory is shared across a repo
 * and its `.claude/worktrees/<slug>` children — Claude Code keys it
 * by the **parent repo path**, not the runtime cwd. The verb resolves
 * `identity.repo` (the recorded source repo) and encodes that path,
 * so a teammate launched inside a worktree still surfaces the
 * sibling repo's memory.
 *
 * Three outcomes carry into the verb-layer formatter:
 *
 *  - `kind: 'text'` — file present (possibly empty); content verbatim.
 *  - `kind: 'not-supported'` — file absent; the formatter renders the
 *    diagnostic on stderr with exit 0.
 *  - `kind: 'failed'` — the teammate has no identity record (kill +
 *    respawn migration message) or the recorded repo path is gone.
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { encodeProjectDir } from '../../persistence/paths'
import { read as readIdentity } from '../../persistence/identity-store'
import type { TeammateName, TextResult } from '../types'

/** Whether a path exists and is a regular file. */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Whether a path exists and is a directory. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export interface ClaudeMemEnv {
  readonly dispatcherDir: string
  readonly projectsDir: string
}

/**
 * The `~/.claude/projects/<dir>` directory for a teammate. Resolved
 * from `identity.repo` (not `identity.cwd`) — worktrees share their
 * parent repo's AutoMemory.
 */
export function projectDirForName(name: TeammateName, env: ClaudeMemEnv): string | null {
  const identity = readIdentity(name)
  const target = identity === null ? join(env.dispatcherDir, name) : identity.repo
  if (!isDirectory(target)) return null
  const phys = realpathSync(target)
  return join(env.projectsDir, encodeProjectDir(phys))
}

/**
 * The "repo not under dispatcher dir" diagnostic, byte-identical to
 * the legacy `dieRepoNotFound`. Two branches: dispatcher dir itself
 * is a git working tree (steer the user to `cd ..`), or the generic
 * miss (instruction to set `TM_DISPATCHER_DIR`).
 */
export function repoNotFoundMessage(
  verb: string,
  name: TeammateName,
  expected: string,
  dispatcherDir: string,
): string {
  if (isDirectory(join(dispatcherDir, '.git'))) {
    return (
      `${dispatcherDir} looks like a git working tree (.git exists), not a dispatcher root.\n` +
      '    The dispatcher dir should be the PARENT of your sibling repos.\n' +
      `    Try:  cd "${dirname(dispatcherDir)}" && tm ${verb} ${name}\n` +
      "    (Or set TM_DISPATCHER_DIR in your dispatcher's .claude/settings.json\n" +
      '    — run /claudemux:setup to wire it up automatically.)'
    )
  }
  return (
    `repo not found at ${expected} — the teammate's identity record points at ` +
    `a directory that no longer exists. Re-spawn with 'tm spawn <path> --name ${name}' ` +
    `(or fix the path) to recover.`
  )
}

export function claudeMem(name: TeammateName, env: ClaudeMemEnv): TextResult {
  const identity = readIdentity(name)
  if (identity === null) {
    return {
      kind: 'failed',
      message:
        `tm mem: no identity record for '${name}'. Spawn it with ` +
        `'tm spawn <path> --name ${name}' first, or check 'tm ls'.`,
    }
  }
  if (!isDirectory(identity.repo)) {
    return {
      kind: 'failed',
      message: repoNotFoundMessage('mem', name, identity.repo, env.dispatcherDir),
    }
  }
  const projectDir = projectDirForName(name, env)
  if (projectDir === null) {
    return {
      kind: 'failed',
      message: repoNotFoundMessage('mem', name, identity.repo, env.dispatcherDir),
    }
  }
  const mfile = join(projectDir, 'memory', 'MEMORY.md')
  if (!isRegularFile(mfile)) {
    return {
      kind: 'not-supported',
      reason: `tm mem: no auto-memory recorded for ${name} (looked at ${mfile})`,
    }
  }
  return { kind: 'text', text: readFileSync(mfile, 'utf8') }
}
