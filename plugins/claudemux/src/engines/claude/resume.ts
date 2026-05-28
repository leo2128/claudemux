/**
 * `tm resume` (Claude) — relaunch a prior conversation. With no sid
 * the verb delegates session choice to the Claude CLI's native
 * `--continue`. With a sid it proves the transcript exists at the
 * recorded cwd's project-dir, then delegates to `spawn --resume`.
 *
 * Schema 2 changes:
 *  - The repo / worktree / cwd are passed in explicitly from the
 *    engine-router argv (`--repo`, `--cwd`, `--worktree-slug`); the
 *    legacy `<repo> sid` two-positional form is gone.
 *  - The teammate identity is the flat `<name>` (not a repo path);
 *    the tmux-session existence guard reads off `tmuxSessionName(name)`.
 */

import { join } from 'node:path'

import { claudeContinue, claudeSpawn } from './spawn'
import { isRegularFile } from './idle'
import { UUID_RE } from './identifiers'
import { encodeProjectDir, tmuxSessionName } from '../../persistence/paths'
import { die, sessionExists } from './tmux'
import { looksLikeUuidPrefix } from '../../identity/uuid-prefix'
import type { ClaudeVerbEnv } from './env'
import type { TmResult } from '../../tm'

interface ParsedClaudeResume {
  name: string
  repo: string
  cwd: string
  worktreeSlug: string | null
  displayName: string
  sid: string
  prompt: string
  hasPrompt: boolean
}

function parseResumeRouterArgs(
  args: readonly string[],
): ParsedClaudeResume | { error: TmResult } {
  const name = args[0] ?? ''
  if (name.length === 0) return { error: die('claude resume: <name> required') }
  let repo = ''
  let cwd = ''
  let worktreeSlug: string | null = null
  let displayName = ''
  let sid = ''
  let prompt = ''
  let hasPrompt = false
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!
    const next = (): string | null => {
      const value = args[i + 1]
      if (value === undefined) return null
      i++
      return value
    }
    if (arg === '--repo') {
      const v = next()
      if (v === null) return { error: die('claude resume: --repo requires a value') }
      repo = v
    } else if (arg === '--cwd') {
      const v = next()
      if (v === null) return { error: die('claude resume: --cwd requires a value') }
      cwd = v
    } else if (arg === '--worktree-slug') {
      const v = next()
      if (v === null) return { error: die('claude resume: --worktree-slug requires a value') }
      worktreeSlug = v
    } else if (arg === '--display-name') {
      const v = next()
      if (v === null) return { error: die('claude resume: --display-name requires a value') }
      displayName = v
    } else if (arg === '--prompt') {
      const v = next()
      if (v === null) return { error: die('claude resume: --prompt requires a value') }
      prompt = v
      hasPrompt = true
    } else if (arg.startsWith('-')) {
      return { error: die(`claude resume: unknown flag: ${arg}`) }
    } else if (sid === '') {
      sid = arg
    } else {
      return { error: die(`claude resume: unexpected positional '${arg}'`) }
    }
  }
  if (repo.length === 0) return { error: die('claude resume: missing --repo') }
  if (cwd.length === 0) cwd = repo
  return { name, repo, cwd, worktreeSlug, displayName, sid, prompt, hasPrompt }
}

export async function claudeResume(args: readonly string[], env: ClaudeVerbEnv): Promise<TmResult> {
  const parsed = parseResumeRouterArgs(args)
  if ('error' in parsed) return parsed.error
  const { name, repo, cwd, worktreeSlug, displayName, prompt, hasPrompt } = parsed
  let { sid } = parsed

  const session = tmuxSessionName(name)
  if (await sessionExists(session, env.runTmux)) {
    return die(
      `${name} already running (tmux=${session}) — 'tm kill ${name}' first ` +
        'if you really want to start over',
    )
  }

  const spawnArgs: string[] = [name, '--repo', repo, '--cwd', cwd]
  if (worktreeSlug !== null) spawnArgs.push('--worktree-slug', worktreeSlug)
  if (displayName.length > 0) spawnArgs.push('--display-name', displayName)
  if (hasPrompt) spawnArgs.push('--prompt', prompt)

  if (sid === '') {
    return claudeContinue(name, spawnArgs.slice(1), env)
  }

  // The transcript directory Claude uses is keyed by the runtime
  // cwd (the worktree path when `--worktree-slug` is set). Probe
  // there for the sid.
  const projectDir = join(env.projectsDir, encodeProjectDir(cwd))
  const target = join(projectDir, `${sid}.jsonl`)
  if (!isRegularFile(target)) {
    if (looksLikeUuidPrefix(sid)) {
      return die(
        `received '${sid}', looks like a sid prefix; resume requires the ` +
          `full sid. Run 'tm history ${name} ${sid}' to expand it, or ` +
          `'tm history ${name}' to list past sessions with full ids.`,
      )
    }
    return die(
      `no transcript at ${target} — wrong name/worktree for this sid, or sid does not ` +
        `exist. Check 'ls ${projectDir}/'.`,
    )
  }
  if (!UUID_RE.test(sid)) {
    if (looksLikeUuidPrefix(sid)) {
      return die(
        `received '${sid}', looks like a sid prefix; resume requires the ` +
          `full sid. Run 'tm history ${name} ${sid}' to expand it.`,
      )
    }
    return die(`sid is not a valid uuid: ${sid}`)
  }

  spawnArgs.splice(1, 0, '--resume', sid)
  // After splice: [name, --resume, sid, --repo, ..., --cwd, ..., ...]
  return claudeSpawn(spawnArgs, env)
}
