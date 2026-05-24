/**
 * Repo-resolution helpers — the dispatcher-tree → physical-path →
 * `~/.claude/projects/<dir>` mapping `tm history`, `tm mem`, and
 * `tm resume` all reach for.
 */

import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { encodeProjectDir } from '../../paths'
import { isDirectory } from './idle'
import { die } from './tmux'
import type { TeammateName } from '../types'
import type { TmResult } from '../../tm'

export interface RepoFsEnv {
  readonly dispatcherDir: string
  readonly projectsDir: string
}

/**
 * The Claude Code project directory for a teammate repo — `tm`'s
 * `project_dir_for_repo`. The repo's *physical* path (symlinks resolved,
 * as `cd && pwd -P` does) is encoded, so a symlinked dispatcher tree
 * still addresses the directory Claude Code actually wrote on disk.
 *
 * The caller must have already confirmed `<dispatcherDir>/<name>`
 * exists — `realpathSync` needs a real path.
 */
export function projectDirForRepo(name: TeammateName, env: RepoFsEnv): string {
  const phys = realpathSync(join(env.dispatcherDir, name))
  return join(env.projectsDir, encodeProjectDir(phys))
}

/**
 * `tm`'s `die_repo_not_found`. Two branches: dispatcher dir itself is
 * a git working tree (steer the user to `cd ..`), or the generic miss
 * (instruction to set `TM_DISPATCHER_DIR`).
 */
export function dieRepoNotFound(
  verb: string,
  name: TeammateName,
  expected: string,
  dispatcherDir: string,
): TmResult {
  if (isDirectory(join(dispatcherDir, '.git'))) {
    return die(
      `${dispatcherDir} looks like a git working tree (.git exists), not a dispatcher root.\n` +
        '    The dispatcher dir should be the PARENT of your sibling repos.\n' +
        `    Try:  cd "${dirname(dispatcherDir)}" && tm ${verb} ${name}\n` +
        "    (Or set TM_DISPATCHER_DIR in your dispatcher's .claude/settings.json\n" +
        '    — run /claudemux:setup to wire it up automatically.)',
    )
  }
  return die(
    `repo not found at ${expected} — <repo> must be a direct subdirectory of the ` +
      `dispatcher dir (${dispatcherDir}). Dispatcher dir is read from ` +
      "TM_DISPATCHER_DIR (env) or $PWD; if it's wrong, set TM_DISPATCHER_DIR or " +
      'run tm from the right place.',
  )
}
