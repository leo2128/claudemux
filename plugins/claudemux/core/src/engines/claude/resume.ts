/**
 * `tm resume` — relaunch a prior conversation. With no sid the verb
 * delegates session choice to the Claude CLI's native `--continue`.
 * With a sid it proves the transcript exists, then delegates to
 * `spawn --resume`.
 */

import { join } from 'node:path'

import { claudeContinue, claudeSpawn } from './spawn'
import { isDirectory, isRegularFile } from './idle'
import { UUID_RE } from './identifiers'
import { dieRepoNotFound, projectDirForRepo } from './repo-fs'
import { die, sessionExists } from './tmux'
import { tmuxSessionName } from '../../persistence/paths'
import { looksLikeUuidPrefix } from '../../identity/uuid-prefix'
import { parseResumeArgs } from '../../shared/verb-args'
import type { ClaudeVerbEnv } from './env'
import type { TmResult } from '../../tm'

export async function claudeResume(args: readonly string[], env: ClaudeVerbEnv): Promise<TmResult> {
  const parsed = parseResumeArgs(args)
  if ('error' in parsed) return parsed.error
  let { sid } = parsed
  const { repo, task, prompt, hasPrompt } = parsed
  if (repo === '') {
    return die(
      'usage: tm resume <repo> [<sid>] [--task <slug>] [--prompt "..."]  ' +
        '(omit sid to delegate latest-session selection to Claude --continue; ' +
        '--task relabels the resumed conversation)',
    )
  }

  const path = join(env.dispatcherDir, repo)
  if (!isDirectory(path)) return dieRepoNotFound('resume', repo, path, env.dispatcherDir)

  const name = tmuxSessionName(repo)
  if (await sessionExists(name, env.runTmux)) {
    return die(
      `${repo} already running (tmux=${name}) — 'tm kill ${repo}' first ` +
        'if you really want to start over',
    )
  }

  if (sid === '') {
    // `tm resume` does not expose `--timeout` today; pass `null` so the
    // inner `tm send` handoff uses its default (1800s). When resume grows
    // its own `--timeout` surface, this is the wire to thread it through.
    return claudeContinue(repo, { task, prompt, hasPrompt, timeout: null }, env)
  }

  const projectDir = projectDirForRepo(repo, env)
  const target = join(projectDir, `${sid}.jsonl`)
  if (!isRegularFile(target)) {
    if (looksLikeUuidPrefix(sid)) {
      return die(
        `received '${sid}', looks like a sid prefix; resume requires the ` +
          `full sid. Run 'tm history ${repo} ${sid}' to expand it, or ` +
          `'tm history ${repo}' to list past sessions with full ids.`,
      )
    }
    return die(
      `no transcript at ${target} — wrong repo for this sid, or sid does not ` +
        `exist. Check 'ls ${projectDir}/'.`,
    )
  }

  if (!UUID_RE.test(sid)) {
    if (looksLikeUuidPrefix(sid)) {
      return die(
        `received '${sid}', looks like a sid prefix; resume requires the ` +
          `full sid. Run 'tm history ${repo} ${sid}' to expand it, or ` +
          `'tm history ${repo}' to list past sessions with full ids.`,
      )
    }
    return die(`sid is not a valid uuid: ${sid}`)
  }

  // Delegate the rest of the launch to `claudeSpawn` via its `--resume`
  // path. This mirrors `cmd_resume`'s `cmd_spawn` recursion: the launch
  // flags and the optional `--prompt` follow-up are spawn's concern,
  // not resume's.
  const spawnArgs: string[] = [repo, '--resume', sid]
  if (task.length > 0) {
    spawnArgs.push('--task', task)
  }
  if (hasPrompt) {
    spawnArgs.push('--prompt', prompt)
  }
  const result = await claudeSpawn(spawnArgs, env)
  return result
}
