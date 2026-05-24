/**
 * `tm resume` — relaunch a prior conversation. With no sid the verb
 * falls back to "newest jsonl by mtime" (a stderr warning prompts the
 * caller to pass an explicit sid from the dispatcher's task ledger).
 * With a sid it proves the transcript exists, then delegates to
 * `spawn --resume`.
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { claudeSpawn } from './spawn'
import { isDirectory, isRegularFile } from './idle'
import { UUID_RE } from './identifiers'
import { dieRepoNotFound, projectDirForRepo } from './repo-fs'
import { die, sessionExists } from './tmux'
import { fmtLocalDateTime } from './clock'
import { tmuxSessionName } from './persistence'
import type { ClaudeVerbEnv } from './env'
import type { TmResult } from '../../tm'

/** Parsed arg vector for `tm resume`. */
export interface ResumeArgs {
  repo: string
  sid: string
  task: string
  prompt: string
  hasPrompt: boolean
}

/**
 * `cmd_resume`'s arg loop; two positionals (`<repo> [<sid>]`) plus
 * flags. Like `cmd_spawn`, `--task` is bash's silent-exit-1 path (no
 * `[[ $# -ge 2 ]]` guard); `--prompt` is the explicit-die path.
 */
export function parseResumeArgs(args: readonly string[]): ResumeArgs | { error: TmResult } {
  const SILENT: TmResult = { code: 1, stdout: '', stderr: '' }
  let repo = ''
  let sid = ''
  let task = ''
  let prompt = ''
  let hasPrompt = false
  let i = 0
  while (i < args.length) {
    const arg = args[i]!
    if (arg === '--prompt') {
      if (i + 1 >= args.length) return { error: die('tm resume: --prompt requires a value') }
      prompt = args[i + 1]!
      hasPrompt = true
      i += 2
    } else if (arg.startsWith('--prompt=')) {
      prompt = arg.slice('--prompt='.length)
      hasPrompt = true
      i++
    } else if (arg === '--task') {
      if (i + 1 >= args.length) return { error: SILENT }
      task = args[i + 1]!
      i += 2
    } else if (arg.startsWith('--task=')) {
      task = arg.slice('--task='.length)
      i++
    } else if (arg === '--') {
      i++
      break
    } else if (arg.startsWith('-')) {
      return { error: die(`unknown flag: ${arg}`) }
    } else if (repo === '') {
      repo = arg
      i++
    } else if (sid === '') {
      sid = arg
      i++
    } else {
      return {
        error: die(
          `tm resume: too many positional args (got '${arg}' after ` +
            `repo='${repo}' sid='${sid}')`,
        ),
      }
    }
  }
  return { repo, sid, task, prompt, hasPrompt }
}

export async function claudeResume(args: readonly string[], env: ClaudeVerbEnv): Promise<TmResult> {
  const parsed = parseResumeArgs(args)
  if ('error' in parsed) return parsed.error
  let { sid } = parsed
  const { repo, task, prompt, hasPrompt } = parsed
  if (repo === '') {
    return die(
      'usage: tm resume <repo> [<sid>] [--task <slug>] [--prompt "..."]  ' +
        '(sid from ledger preferred; auto-pick on omit; --task relabels the ' +
        'resumed conversation)',
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

  const projectDir = projectDirForRepo(repo, env)
  let autoPickStderr = ''

  if (sid === '') {
    if (!isDirectory(projectDir)) {
      return die(
        `no project dir at ${projectDir} — has anyone ever run claude inside ` +
          `${path}? Try 'tm spawn ${repo}' first.`,
      )
    }
    let names: string[] = []
    try {
      names = readdirSync(projectDir).filter((file) => file.endsWith('.jsonl'))
    } catch {
      names = []
    }
    if (names.length === 0) {
      return die(`no .jsonl transcripts under ${projectDir} — try 'tm spawn ${repo}' to start fresh.`)
    }
    const stats = names.map((file) => {
      let mtime = 0
      try {
        mtime = Math.floor(statSync(join(projectDir, file)).mtimeMs / 1000)
      } catch {
        mtime = 0
      }
      return { file, mtime }
    })
    stats.sort((a, b) => b.mtime - a.mtime || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    const latest = stats[0]!
    sid = latest.file.replace(/\.jsonl$/, '')
    autoPickStderr =
      `tm resume: no sid given — auto-picked ${sid} (jsonl mtime ` +
      `${fmtLocalDateTime(latest.mtime)}). Prefer passing the sid from your task ledger.\n`
  } else {
    const target = join(projectDir, `${sid}.jsonl`)
    if (!isRegularFile(target)) {
      return die(
        `no transcript at ${target} — wrong repo for this sid, or sid does not ` +
          `exist. Check 'ls ${projectDir}/'.`,
      )
    }
  }

  if (!UUID_RE.test(sid)) return die(`sid is not a valid uuid: ${sid}`)

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
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: autoPickStderr + result.stderr,
  }
}
