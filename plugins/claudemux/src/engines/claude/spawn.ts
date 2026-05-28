/**
 * `tm spawn` — launch a Claude teammate (optionally inside a git
 * worktree), record its sid + cwd, and either return as soon as
 * `SessionStart` fires or hand off to a sync `tm send` when
 * `--prompt` is set.
 *
 * Worktree integration: when `--worktree-slug <slug>` is passed,
 * `claude` itself receives `--worktree <slug>` and creates
 * `<repo>/.claude/worktrees/<slug>` (a real `git worktree add` under
 * the hood, branch `worktree-<slug>`, baseRef `head` per the engine
 * `--settings` block). claudemux predicts the worktree path before
 * launch, writes it to `/tmp/teammate-<name>.cwd` so the
 * SessionStart hook's byte-match succeeds when Claude reports its
 * runtime cwd, and points the tmux pane at the parent repo so
 * Claude can perform the chdir itself.
 *
 * Repository discipline: this verb writes the `<name>.cwd` /
 * `<name>.sid` markers and the empty `<sid>.last` sentinel; the
 * SessionStart hook separately produces the `<name>.ready` marker
 * the poll below blocks on. Tearing those apart is what makes
 * `tm spawn --prompt` atomic — the pre-send sleep happens against a
 * REPL that has already booted.
 *
 * This module is Claude-only. The engine router owns cross-engine
 * dispatch.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { claudeSend } from './send'
import { readLastAssistantText, transcriptFile } from './ctx'
import { clearIdle, isDirectory } from './idle'
import { newSid } from './identifiers'
import { sleepMs } from './clock'
import { dieRepoNotFound } from './repo-fs'
import { die, sessionExists } from './tmux'
import {
  cwdFile,
  idleDir,
  lastFileFor,
  readyFile,
  sidFile,
  tmuxSessionName,
  worktreePathFor,
} from '../../persistence/paths'
import type { ClaudeVerbEnv } from './env'
import { EXIT_SYNC_WAIT_EXPIRED, type TmResult } from '../../tm'

interface ClaudeLaunchArgs {
  /** Physical repo path (the parent of the worktree, or the cwd itself). */
  readonly repo: string
  /** Runtime cwd — equals `worktreePathFor(repo, worktreeSlug)` when set, else `repo`. */
  readonly cwd: string
  /** Worktree slug; `null` for `--no-worktree`. */
  readonly worktreeSlug: string | null
  readonly resumeSid: string
  readonly continueLatest: boolean
  readonly displayName: string
  readonly prompt: string
  readonly hasPrompt: boolean
  /**
   * Caller-supplied `--timeout` (seconds, decimal string) for the inner
   * `tm send` handoff on the `--prompt` sync path. `null` means "use the
   * `tm send` default" (1800s). MUST be honored or `tm spawn --prompt
   * --timeout N` silently waits 1800s and the dispatcher's 124 classifier
   * never fires inside the window it was scheduled against.
   */
  readonly timeout: string | null
}

/**
 * Single-quote-escape a string for safe embedding in a bash command
 * line. `tm`'s shell-out builds the `claude --session-id ... -n '...'`
 * string and passes it to `tmux send-keys`; the native form constructs
 * the same string so the running REPL's argv is byte-equal to bash's.
 */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * `tm`'s `teammate_launch_flags`: the flag string between
 * `claude --session-id|--resume <sid>` and the optional `-n '<name>'`
 * / `--worktree <slug>` extras. A bare tool name in
 * `--disallowedTools` drops it from the model's context entirely.
 */
function teammateLaunchFlags(mdExcludes: string): string {
  return `--settings ${shellSingleQuote(mdExcludes)} --disallowedTools AskUserQuestion`
}

/**
 * The settings JSON merged into every teammate launch. Two
 * behaviours live here:
 *
 *  - `claudeMdExcludes` keeps the dispatcher's CLAUDE.md /
 *    CLAUDE.local.md out of the teammate's context (a teammate
 *    inherits its own repo's CLAUDE.md, not the dispatcher's).
 *
 *  - `worktree.baseRef = "head"` pins the worktree's base to local
 *    HEAD, not `origin/<default>`. Dispatchers often spawn teammates
 *    on top of branches with local commits not yet pushed; `fresh`
 *    would silently rewind that work. The block is only emitted when
 *    a worktree is actually requested — `--no-worktree` runs leave
 *    the user's global `worktree.*` settings undisturbed.
 */
function teammateSettingsJson(
  dispatcherDir: string,
  worktreeSlug: string | null,
): string {
  const settings: Record<string, unknown> = {
    claudeMdExcludes: [
      `${dispatcherDir}/CLAUDE.md`,
      `${dispatcherDir}/CLAUDE.local.md`,
    ],
  }
  if (worktreeSlug !== null) {
    settings['worktree'] = { baseRef: 'head' }
  }
  return JSON.stringify(settings)
}

/**
 * Run `tm spawn`'s readiness poll: block until `<name>.ready` appears
 * or 18s (60 × 0.3s) elapse. Returns the ms it took to fire, or `null`
 * on timeout — the caller prints the verb's stderr accordingly.
 */
async function pollReady(name: string): Promise<number | null> {
  const rf = readyFile(name)
  for (let i = 1; i <= 60; i++) {
    if (existsSync(rf)) return i * 300
    await sleepMs(300)
  }
  return null
}

/**
 * Public Claude spawn entrypoint. Argument shape matches the engine
 * router's `argv = [name, --repo R, --cwd C, --worktree-slug S,
 * --resume SID, --display-name DN, --prompt P, --timeout N]`.
 */
export async function claudeSpawn(
  args: readonly string[],
  env: ClaudeVerbEnv,
): Promise<TmResult> {
  const name = args[0] ?? ''
  if (name.length === 0) {
    return die('usage: tm spawn <path> [--name <id>] [--prompt "..."]')
  }
  const launch = parseClaudeLaunchArgs(args.slice(1))
  if ('error' in launch) return launch.error
  return claudeLaunch({
    repo: launch.repo,
    cwd: launch.cwd,
    worktreeSlug: launch.worktreeSlug,
    resumeSid: launch.resumeSid,
    continueLatest: false,
    displayName: launch.displayName,
    prompt: launch.prompt,
    hasPrompt: launch.hasPrompt,
    timeout: launch.timeout,
  }, env, name)
}

/**
 * Equivalent of `claudeSpawn` for the `--continue` flavour. The
 * engine router calls this from the resume verb on the Claude
 * continue-latest path.
 */
export async function claudeContinue(
  name: string,
  args: readonly string[],
  env: ClaudeVerbEnv,
): Promise<TmResult> {
  const launch = parseClaudeLaunchArgs(args)
  if ('error' in launch) return launch.error
  return claudeLaunch({
    repo: launch.repo,
    cwd: launch.cwd,
    worktreeSlug: launch.worktreeSlug,
    resumeSid: '',
    continueLatest: true,
    displayName: launch.displayName,
    prompt: launch.prompt,
    hasPrompt: launch.hasPrompt,
    timeout: launch.timeout,
  }, env, name)
}

interface ParsedClaudeLaunch {
  repo: string
  cwd: string
  worktreeSlug: string | null
  resumeSid: string
  displayName: string
  prompt: string
  hasPrompt: boolean
  timeout: string | null
}

/**
 * Decode the engine-router argv into a `ParsedClaudeLaunch`. The
 * Claude engine's `spawn()` builds these args from the SpawnRequest
 * fields the CLI dispatcher resolved; this is the matching unpack.
 *
 * Any flag the router does not currently emit (e.g. legacy
 * `--repo-relative`) is rejected, surfaced via `parseSpawnArgs` for
 * the legacy paths still exercised by `claudeSpawn` consumers.
 */
function parseClaudeLaunchArgs(
  args: readonly string[],
): ParsedClaudeLaunch | { error: TmResult } {
  let repo = ''
  let cwd = ''
  let worktreeSlug: string | null = null
  let displayName = ''
  let resumeSid = ''
  let prompt = ''
  let hasPrompt = false
  let timeout: string | null = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const consumeValue = (): string | null => {
      const next = args[i + 1]
      if (next === undefined) return null
      i++
      return next
    }
    if (arg === '--repo') {
      const v = consumeValue()
      if (v === null) return { error: die('claude spawn: --repo requires a value') }
      repo = v
    } else if (arg === '--cwd') {
      const v = consumeValue()
      if (v === null) return { error: die('claude spawn: --cwd requires a value') }
      cwd = v
    } else if (arg === '--worktree-slug') {
      const v = consumeValue()
      if (v === null) return { error: die('claude spawn: --worktree-slug requires a value') }
      worktreeSlug = v
    } else if (arg === '--display-name') {
      const v = consumeValue()
      if (v === null) return { error: die('claude spawn: --display-name requires a value') }
      displayName = v
    } else if (arg === '--resume') {
      const v = consumeValue()
      if (v === null) return { error: die('claude spawn: --resume requires a value') }
      resumeSid = v
    } else if (arg === '--prompt') {
      const v = consumeValue()
      if (v === null) return { error: die('claude spawn: --prompt requires a value') }
      prompt = v
      hasPrompt = true
    } else if (arg === '--timeout') {
      const v = consumeValue()
      if (v === null) return { error: die('claude spawn: --timeout requires a value') }
      timeout = v
    } else {
      return { error: die(`claude spawn: unknown flag: ${arg}`) }
    }
  }
  if (repo.length === 0) return { error: die('claude spawn: missing --repo') }
  if (cwd.length === 0) cwd = repo
  return { repo, cwd, worktreeSlug, resumeSid, displayName, prompt, hasPrompt, timeout }
}

async function claudeLaunch(
  req: ClaudeLaunchArgs,
  env: ClaudeVerbEnv,
  name: string,
): Promise<TmResult> {
  const { repo, cwd, worktreeSlug, resumeSid, continueLatest, displayName, prompt, hasPrompt, timeout } = req
  if (!isDirectory(repo)) return dieRepoNotFound('spawn', name, repo, env.dispatcherDir)

  // The tmux pane is anchored at the repo root. When a worktree is
  // requested, `claude --worktree <slug>` performs the chdir into
  // `<repo>/.claude/worktrees/<slug>` itself; the recorded `.cwd`
  // matches that final runtime path so the SessionStart hook's
  // byte-match against the hook payload succeeds.
  const paneCwd = repo
  const mdExcludes = teammateSettingsJson(env.dispatcherDir, worktreeSlug)

  const session = tmuxSessionName(name)
  if (await sessionExists(session, env.runTmux)) {
    if (hasPrompt) {
      return die(
        `${name} already exists (tmux=${session}) — atomic bootstrap rejected ` +
          'because the teammate is already running. Use ' +
          `'tm send ${name} --prompt "…"' to drive an existing teammate, or ` +
          `'tm kill ${name}' first to start over.`,
      )
    }
    return {
      code: 0,
      stdout:
        `${name} already exists (tmux=${session}; use 'tm status ${name}' to view, ` +
        `or 'tm kill ${name}' first)\n`,
      stderr: '',
    }
  }

  // Clear the readiness signal BEFORE launching `claude`. The
  // SessionStart hook re-touches the file once the REPL is up; the
  // poll below blocks on it.
  const rf = readyFile(name)
  rmSync(rf, { force: true })

  // Record the teammate's runtime cwd in place *before* spawning so
  // the SessionStart hook finds it on its first attempt. The runtime
  // cwd already reflects the worktree path (Claude's `--worktree`
  // chdir target) when one is in use.
  const cf = cwdFile(name)
  mkdirSync(dirname(cf), { recursive: true })
  writeFileSync(cf, `${cwd}\n`)

  // `-P -F '#{session_id}'` returns the new session's internal id;
  // use it as the subsequent `send-keys` target so prefix-match
  // cannot wrong-route. `-e CLAUDEMUX_TEAMMATE_NAME=...` is the
  // positive identity gate the on-session-start hook reads to
  // discriminate "this teammate" from "the dispatcher happens to
  // share the cwd".
  let paneId = ''
  try {
    const newSession = await env.runTmux([
      'new-session',
      '-d',
      '-s',
      session,
      '-c',
      paneCwd,
      '-e',
      `CLAUDEMUX_TEAMMATE_NAME=${name}`,
      '-P',
      '-F',
      '#{session_id}',
    ])
    if (newSession.code !== 0) {
      return die(`tmux new-session failed: ${newSession.stderr.trim() || newSession.stdout.trim()}`)
    }
    paneId = newSession.stdout.split('\n')[0] ?? ''
  } catch (err) {
    return die(`tmux new-session failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (paneId.length === 0) return die(`tmux new-session returned no session id for ${name}`)

  const sid = resumeSid.length > 0 ? resumeSid : continueLatest ? '' : newSid()
  const launchFlags = teammateLaunchFlags(mdExcludes)
  const nameArg =
    displayName.length > 0 ? ` -n ${shellSingleQuote(displayName)}` : ` -n ${shellSingleQuote(name)}`
  const worktreeArg = worktreeSlug !== null ? ` --worktree ${shellSingleQuote(worktreeSlug)}` : ''
  const launchCmd =
    continueLatest
      ? `claude --continue ${launchFlags}${nameArg}${worktreeArg}`
      : resumeSid.length > 0
      ? `claude --resume ${sid} ${launchFlags}${nameArg}${worktreeArg}`
      : `claude --session-id ${sid} ${launchFlags}${nameArg}${worktreeArg}`
  await env.runTmux(['send-keys', '-t', paneId, launchCmd, 'Enter'])

  let stderr = ''
  const worktreeNote = worktreeSlug !== null ? `, worktree=${worktreePathFor(repo, worktreeSlug)}` : ''
  if (continueLatest) {
    stderr +=
      `spawned: ${name} (tmux=${session}, cwd=${cwd}${worktreeNote}, continued latest sid=pending)\n`
  } else if (resumeSid.length > 0) {
    stderr += `spawned: ${name} (tmux=${session}, cwd=${cwd}${worktreeNote}, resumed sid=${sid})\n`
  } else {
    stderr += `spawned: ${name} (tmux=${session}, cwd=${cwd}${worktreeNote}, sid=${sid})\n`
  }

  if (!continueLatest) {
    const sf = sidFile(name)
    mkdirSync(dirname(sf), { recursive: true })
    writeFileSync(sf, `${sid}\n`)
    clearIdle(sid)
  }

  // `.last` seed. `clearIdle` above just removed the prior file;
  // without a re-seed here, `tm last` / `tm send`'s "(no text
  // reply…)" sentinel is the only thing the dispatcher can observe
  // until the on-stop hook writes a fresh extraction — and that
  // hook can return empty (tool-only turn, transcript-walk halting
  // on a meta user entry) and `rm` the file, leaving the
  // dispatcher with nothing.
  //
  //   - Fresh spawn: write the empty sentinel. `tm last` reports the
  //     "no reply yet" state until the first real Stop.
  //   - Resume: extract the prior turn's assistant text from the
  //     existing transcript and seed `.last` with it (or the empty
  //     sentinel when no such text exists). The dispatcher can read the
  //     pre-relaunch deliverable immediately, and a hook miss on the
  //     next turn leaves that prior text in place rather than a
  //     missing file.
  //   - Continue-latest: sid is unknown until SessionStart fires and
  //     writes `.sid`, so there is nothing to key the marker by yet.
  //     The on-stop hook will create `.last` once it has a sid.
  if (!continueLatest) {
    mkdirSync(idleDir(), { recursive: true })
    if (resumeSid.length === 0) {
      writeFileSync(lastFileFor(sid), '')
    } else {
      const jsonl = transcriptFile(env.projectsDir, cwd, sid)
      const prior = readLastAssistantText(jsonl)
      writeFileSync(lastFileFor(sid), prior.length > 0 ? `${prior}\n` : '')
    }
  }

  const readyAfter = await pollReady(name)
  if (readyAfter !== null) {
    stderr += `ready: ${name} (tmux=${session}, SessionStart fired after ~${readyAfter} ms)\n`
  } else {
    stderr +=
      `WARN: ${name} (tmux=${session}) did not signal ready within 18s ` +
      "(no SessionStart hook fire — the plugin's on-session-start.sh may not " +
      'be loaded, or claude failed to boot). Continuing, but if the REPL is ' +
      "actually dead, a subsequent sync 'tm send' / 'tm spawn --prompt' / " +
      "'tm compact' will block until its --timeout expires (default 1800s) " +
      `and then exit ${EXIT_SYNC_WAIT_EXPIRED} (sync wait expired). ` +
      `'tm status ${name}' shows the live pane if you need to verify.\n`
  }

  if (!hasPrompt) {
    return { code: 0, stdout: '', stderr }
  }

  // Atomic bootstrap: settle, then hand off to `tm send`.
  await sleepMs(3000)
  const sendArgs: string[] = [name, '--prompt', prompt]
  if (timeout !== null) sendArgs.push('--timeout', timeout)
  const sendResult = await claudeSend(sendArgs, env)
  return {
    code: sendResult.code,
    stdout: sendResult.stdout,
    stderr: stderr + sendResult.stderr,
  }
}
