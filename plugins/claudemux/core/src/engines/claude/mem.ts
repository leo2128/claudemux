/**
 * Claude-engine `tm mem` body — print a teammate's Claude Code project
 * memory index (`MEMORY.md` under `~/.claude/projects/<dir>/memory/`).
 *
 * A teammate that never ran Claude Code, or whose project directory was
 * pruned, has no such file; that is a normal "no auto-memory recorded"
 * outcome (the legacy `tm mem` reported it on stderr with exit 0). The
 * structured `TextResult` carries that distinction:
 *
 *  - `kind: 'text'` — file present (possibly empty); content is verbatim.
 *  - `kind: 'not-supported'` — file absent; the verb-layer formatter
 *    renders the diagnostic the way `tm mem` does, on stderr with
 *    exit 0.
 *  - `kind: 'failed'` — the repo did not resolve to a directory under
 *    the dispatcher tree (the `repo-not-found` path).
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { encodeProjectDir } from '../../paths'
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
 * The `~/.claude/projects/<dir>` directory for a teammate. The repo's
 * *physical* path (symlinks resolved, as `cd && pwd -P` does) is encoded,
 * so a symlinked dispatcher tree still addresses the directory Claude
 * Code actually wrote on disk.
 */
export function projectDirForName(name: TeammateName, env: ClaudeMemEnv): string {
  const phys = realpathSync(join(env.dispatcherDir, name))
  return join(env.projectsDir, encodeProjectDir(phys))
}

/**
 * The "repo not under dispatcher dir" diagnostic, byte-identical to the
 * legacy `dieRepoNotFound`. Two branches: dispatcher dir itself is a git
 * working tree (steer the user to `cd ..`), or the generic miss
 * (instruction to set `TM_DISPATCHER_DIR`).
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
    `repo not found at ${expected} — <repo> must be a direct subdirectory of the ` +
    `dispatcher dir (${dispatcherDir}). Dispatcher dir is read from ` +
    "TM_DISPATCHER_DIR (env) or $PWD; if it's wrong, set TM_DISPATCHER_DIR or " +
    'run tm from the right place.'
  )
}

export function claudeMem(name: TeammateName, env: ClaudeMemEnv): TextResult {
  const path = join(env.dispatcherDir, name)
  if (!isDirectory(path)) {
    return { kind: 'failed', message: repoNotFoundMessage('mem', name, path, env.dispatcherDir) }
  }
  const mfile = join(projectDirForName(name, env), 'memory', 'MEMORY.md')
  if (!isRegularFile(mfile)) {
    return {
      kind: 'not-supported',
      reason: `tm mem: no auto-memory recorded for ${name} (looked at ${mfile})`,
    }
  }
  return { kind: 'text', text: readFileSync(mfile, 'utf8') }
}
