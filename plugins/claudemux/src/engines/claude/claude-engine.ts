/**
 * `ClaudeEngine implements Engine`. Decision multi-engine-tui-architecture §"Engine interface"
 * makes this the layer the verb dispatcher routes to; every method is
 * present, every result is a discriminated union.
 *
 * The fleet-visibility methods (`list`, `status`, `kill`) and every
 * teammate-targeted hot path are implemented here or in
 * `engines/claude/<verb>.ts`; `cli/dispatch.ts` reaches them only through
 * `verbs/<verb>.ts` and the Engine registry.
 *
 * The capabilities record below is what verbs branch on. `atomicSend`
 * is the type literal `true` (decision multi-engine-tui-architecture §"Capabilities are
 * structured, not stringly-typed") — Claude Code's `tm send` already
 * blocks for the next Stop hook fire, so the atomic-round-trip rule
 * holds on the Claude side without further work.
 */

import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'

import type {
  CompactRequest,
  CompactResult,
  ContextRequest,
  ContextResult,
  DoctorSection,
  EngineCapabilities,
  EngineContext,
  EngineKind,
  EngineSnapshot,
  HistoryRequest,
  HistoryResult,
  InspectRequest,
  KillRequest,
  KillResult,
  LastRequest,
  MemoryRequest,
  ReloadRequest,
  ReloadResult,
  ResumeRequest,
  ResumeResult,
  SendRequest,
  SpawnRequest,
  SpawnResult,
  StatusRequest,
  TeammateName,
  TeammateListing,
  TeammateStatus,
  TextResult,
  TurnResult,
  WaitRequest,
} from '../types'
import type { Engine } from '../engine'
import type { NativeEnv } from '../../env'
import { claudeCompact } from './compact'
import { claudeCtxLine, claudeCtxUsage } from './ctx'
import { claudeDoctor } from './doctor'
import { claudeHistory, claudeHistoryList } from './history'
import { claudeLast } from './last'
import { claudeMem } from './mem'
import { claudeReload } from './reload'
import { dieRepoNotFound } from './repo-fs'
import { claudeResume } from './resume'
import { claudeSend } from './send'
import { claudeSpawn } from './spawn'
import { claudeWait } from './wait'
import { ClaudeTeammateRecord } from './persistence'
import {
  busyMarkerFor,
  cwdFile,
  idleMarkerFor,
  lastFileFor,
  readyFile,
  sendAtFile,
  sidFile,
  TMUX_SESSION_PREFIX,
  tmuxSessionName,
} from '../../persistence/paths'
import { listingExtras } from './state'
import { pluginJsonPath, tmWrapperPath } from '../../plugin-root'
import type { TmResult } from '../../tm'
import {
  read as readIdentity,
  remove as removeIdentity,
  reserve as reserveIdentity,
} from '../../persistence/identity-store'

/** The Claude engine's capability report. */
export const CLAUDE_CAPABILITIES: EngineCapabilities = {
  atomicSend: true,
  atomicSpawnPrompt: true,
  compaction: 'manual',
  contextUsage: 'transcript-jsonl',
  history: 'transcript-files',
  memory: 'claude-project-memory',
  reload: 'prompt-command',
  resume: 'transcript-id',
  detachedTurn: 'replayable',
  events: 'synthesized',
} as const

/** Trim trailing newlines without touching the rest of the string. */
function rstrip(text: string): string {
  return text.replace(/\n+$/, '')
}

/** Read a file only if it exists and is non-empty (`tm`'s `[[ -s file ]]`). */
function readIfNonEmpty(path: string): string | null {
  try {
    if (statSync(path).size === 0) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** Lookup a teammate's session id, or `null` when the marker is missing. */
function readSid(name: string): string | null {
  const raw = readIfNonEmpty(sidFile(name))
  return raw === null ? null : rstrip(raw)
}

/**
 * Compact representation of an idle marker's existence + mtime — enough
 * for the kill-path SessionEnd watcher to tell "the marker was just
 * touched" from "nothing happened". `null` means the file did not
 * exist; otherwise the value is `mtimeMs`. Captured once before
 * `/exit` is sent and compared on each poll tick.
 */
type MarkerSignature = number | null

function markerSignature(path: string): MarkerSignature {
  try {
    return statSync(path).mtimeMs
  } catch {
    return null
  }
}

/**
 * Whether `current` reflects a marker touch that happened *after*
 * `baseline` was sampled. `on-stop.sh` re-touches the idle marker on
 * every Stop event — including SessionEnd — so an mtime that advances
 * past the baseline (or a marker that appears where there was none)
 * is the positive SessionEnd signal the kill path waits for.
 */
function markerAdvanced(baseline: MarkerSignature, current: MarkerSignature): boolean {
  if (current === null) return false
  if (baseline === null) return true
  return current > baseline
}

/** Lookup a teammate's recorded cwd; `null` if absent. */
function readCwd(name: string): string | null {
  const raw = readIfNonEmpty(cwdFile(name))
  return raw === null ? null : rstrip(raw)
}

/**
 * Production grace budget (ms) for the graceful kill path — 15s
 * wait for SessionEnd after `/exit`, plus 5s wait for SessionEnd
 * after the Enter that confirms the dirty-worktree "Keep" prompt.
 *
 * The success signal in production is the idle marker
 * (`/tmp/claude-idle/<sid>`) being touched by `on-stop.sh` when
 * SessionEnd fires — that runs *before* the tmux pane dies, so on a
 * slow box where REPL teardown takes a few seconds the budget is
 * mostly headroom rather than a wait every kill pays. The 8s
 * predecessor was tight enough that even a fast Linux box on Opus
 * 4.7 would expire it and SIGHUP every kill; 20s leaves the slow
 * tail covered while keeping the fallback well clear of any human
 * impatience threshold.
 *
 * Override via `CLAUDEMUX_KILL_GRACE_MS` so the conformance harness
 * (fake tmux that never reports a pane gone, no real on-stop hook
 * to touch the marker) can keep tests under vitest's default 5s
 * timeout.
 */
function killGraceMs(): number {
  const override = process.env['CLAUDEMUX_KILL_GRACE_MS']
  if (override !== undefined && override !== '') {
    const parsed = Number(override)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return 20000
}

/**
 * Format a graceful-exit budget for the SIGHUP-fallback note. Renders
 * whole seconds as `Ns` (`20s`); sub-second budgets — the conformance
 * harness's `CLAUDEMUX_KILL_GRACE_MS=50` shape — render as `Nms` so
 * the message stays truthful when the override is short.
 */
function describeKillGrace(ms: number): string {
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`
  return `${ms}ms`
}

/** Whether the teammate's tmux session is alive. */
async function hasTmuxSession(env: NativeEnv, sessionName: string): Promise<boolean> {
  try {
    return (await env.runTmux(['has-session', '-t', `=${sessionName}`])).code === 0
  } catch {
    return false
  }
}

type ClaudeIdentityReservation =
  | { kind: 'reserved' }
  | { kind: 'preexisting' }
  | { kind: 'already-exists'; existingEngine: EngineKind }
  | { kind: 'failed'; result: TmResult }

function reserveClaudeIdentityForLaunch(args: {
  readonly name: TeammateName
  /** Physical repo path (parent of the worktree, or the cwd itself for `--no-worktree`). */
  readonly repo: string
  /** Runtime cwd — worktree path or repo. */
  readonly cwd: string
  /** Worktree slug under `.claude/worktrees/`; `null` for `--no-worktree`. */
  readonly worktreeSlug: string | null
  readonly displayName: string | null
  readonly env: NativeEnv
  readonly nowMs: number
  readonly verb: 'spawn' | 'resume'
}): ClaudeIdentityReservation {
  const existing = readIdentity(args.name)
  if (existing !== null) {
    return existing.engine === 'claude'
      ? { kind: 'preexisting' }
      : { kind: 'already-exists', existingEngine: existing.engine }
  }

  // The repo must already exist on disk; the worktree path may not (the
  // Claude engine creates it via `claude --worktree`). Validate the
  // repo, not the runtime cwd.
  try {
    if (!statSync(args.repo).isDirectory()) {
      return {
        kind: 'failed',
        result: dieRepoNotFound(args.verb, args.name, args.repo, args.env.dispatcherDir),
      }
    }
  } catch {
    return {
      kind: 'failed',
      result: dieRepoNotFound(args.verb, args.name, args.repo, args.env.dispatcherDir),
    }
  }

  const record = new ClaudeTeammateRecord({
    name: args.name,
    repo: realpathSync(args.repo),
    cwd: args.cwd,
    worktreeSlug: args.worktreeSlug,
    createdAt: Math.floor(args.nowMs / 1000),
    displayName: args.displayName,
  })
  const reserved = reserveIdentity(record.toJson())
  if (reserved.kind === 'reserved') return { kind: 'reserved' }
  if (reserved.kind === 'taken') {
    return { kind: 'already-exists', existingEngine: reserved.existing.engine }
  }
  return {
    kind: 'failed',
    result: { code: 1, stdout: '', stderr: `tm: ${reserved.message}\n` },
  }
}

/** Decide a teammate's `idle`/`busy`/`unknown` state from the hook markers. */
function deriveState(name: string): 'idle' | 'busy' | 'unknown' {
  const sid = readSid(name)
  if (sid === null) return 'unknown'
  if (existsSync(busyMarkerFor(sid))) return 'busy'
  if (existsSync(idleMarkerFor(sid))) return 'idle'
  return 'unknown'
}

/** `ClaudeEngine` — the Claude Code engine. Stateless; verbs inject `EngineContext`. */
export class ClaudeEngine implements Engine {
  readonly kind: EngineKind = 'claude'
  readonly capabilities = CLAUDE_CAPABILITIES

  /** Runtime adapters (`tmux`, `column`, dispatcher paths) are injected per CLI invocation. */
  constructor(private readonly env: NativeEnv) {}

  // ─── Fleet visibility ──────────────────────────────────────────────

  async list(ctx: EngineContext): Promise<readonly TeammateListing[]> {
    let listing = ''
    try {
      listing = (await this.env.runTmux(['ls'])).stdout
    } catch {
      listing = ''
    }
    // Sample `now` once per `list()` call so a multi-row scan reports
    // the same clock reading across every teammate's LAST age.
    const now = Math.floor(ctx.now() / 1000)
    const out: TeammateListing[] = []
    for (const line of listing.split('\n')) {
      const colon = line.indexOf(':')
      const session = colon >= 0 ? line.slice(0, colon) : line
      if (!session.startsWith(TMUX_SESSION_PREFIX)) continue
      const name = session.slice(TMUX_SESSION_PREFIX.length)
      const extras = listingExtras(name, now)
      const identity = readIdentity(name)
      out.push({
        name,
        engine: 'claude',
        state: deriveState(name),
        repo: identity?.repo ?? readCwd(name) ?? '',
        cwd: identity?.cwd ?? readCwd(name) ?? '',
        worktreeSlug: identity?.worktreeSlug ?? null,
        displayName: identity?.displayName ?? null,
        extras: {
          sidShort: extras.sidShort,
          busy: extras.busy,
          last: extras.last,
          preview: extras.preview,
        },
      })
    }
    return out
  }

  async status(req: StatusRequest, _ctx: EngineContext): Promise<TeammateStatus> {
    const sessionName = tmuxSessionName(req.name)
    if (!(await hasTmuxSession(this.env, sessionName))) return { kind: 'not-found' }

    const linesArg = String(req.lines ?? 80)
    let pane: string | null = null
    try {
      const list = await this.env.runTmux(['list-sessions', '-F', '#{session_id} #{session_name}'])
      if (list.code !== 0) {
        return { kind: 'failed', message: rstrip(list.stderr) || rstrip(list.stdout) || `tmux list-sessions exit ${list.code}` }
      }
      for (const line of list.stdout.split('\n')) {
        const space = line.indexOf(' ')
        if (space >= 0 && line.slice(space + 1) === sessionName) {
          pane = line.slice(0, space)
          break
        }
      }
    } catch (err) {
      return { kind: 'failed', message: err instanceof Error ? err.message : String(err) }
    }
    if (pane === null) {
      // `hasTmuxSession` saw the session but list-sessions did not return a
      // matching row — surface this rather than reporting a successful
      // status without any captured pane content.
      return { kind: 'failed', message: `tmux session ${sessionName} present in has-session but absent from list-sessions` }
    }

    let capture: string
    try {
      const result = await this.env.runTmux(['capture-pane', '-t', pane, '-p', '-S', `-${linesArg}`])
      if (result.code !== 0) {
        return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout) || `tmux capture-pane exit ${result.code}` }
      }
      capture = result.stdout
    } catch (err) {
      return { kind: 'failed', message: err instanceof Error ? err.message : String(err) }
    }

    return {
      kind: 'present',
      name: req.name,
      engine: 'claude',
      state: deriveState(req.name),
      cwd: readCwd(req.name) ?? '',
      pane: capture,
      diagnostics: {
        tmuxSession: sessionName,
        sid: readSid(req.name) ?? '',
      },
    }
  }

  async kill(req: KillRequest, _ctx: EngineContext): Promise<KillResult> {
    const sessionName = tmuxSessionName(req.name)
    const sid = readSid(req.name)

    let running = false
    try {
      running = (await this.env.runTmux(['has-session', '-t', `=${sessionName}`])).code === 0
    } catch {
      running = false
    }

    let exitMode: 'graceful' | 'forced' | 'absent' = 'absent'
    if (running) {
      exitMode = await this.runGracefulExit(sessionName, sid)
    }

    if (sid !== null) {
      rmSync(idleMarkerFor(sid), { force: true })
      rmSync(lastFileFor(sid), { force: true })
      rmSync(busyMarkerFor(sid), { force: true })
    }
    for (const file of [sidFile(req.name), sendAtFile(req.name), readyFile(req.name), cwdFile(req.name)]) {
      rmSync(file, { force: true })
    }

    if (exitMode === 'absent') return { kind: 'not-found' }
    if (exitMode === 'forced') {
      return {
        kind: 'killed',
        note:
          `${req.name}: /exit did not return SessionEnd within ${describeKillGrace(killGraceMs())} — fell back to ` +
          `tmux kill-session (SIGHUP). Any worktree Claude created is preserved; ` +
          `remove with 'git worktree remove --force' if no longer needed.\n`,
      }
    }
    return { kind: 'killed' }
  }

  /**
   * Graceful Claude exit:
   *   1. send `/exit\n` to the pane — clean worktree → auto-clean +
   *      SessionEnd; dirty worktree → TUI prompt waits for input.
   *   2. poll for a SessionEnd signal for up to the first budget.
   *   3. if no signal yet, send `Enter` (picks the default "Keep
   *      worktree" choice on the dirty prompt) and poll again for
   *      the second budget.
   *   4. if still no signal, fall back to `tmux kill-session` (SIGHUP).
   *
   * The SessionEnd signal is *either* the tmux session disappearing
   * (process-level teardown finished) *or* the teammate's idle
   * marker — `/tmp/claude-idle/<sid>` — being touched by `on-stop.sh`
   * when SessionEnd fires. The hook touches the marker before the
   * REPL exits and tmux reaps the pane, so on a slow box the marker
   * flips seconds before `has-session` reports gone. Polling both
   * means a clean kill returns in ~one tick instead of paying the
   * full process-teardown wall-clock.
   *
   * After a marker-signaled clean exit, the pane still hosts the
   * shell that launched Claude — without an explicit `kill-session`
   * the tmux session lives on as a bare prompt and the teammate
   * shows up as `unknown` in `tm ls`. The kill-session call after
   * each graceful branch handles that teardown.
   *
   * Budgets default to 15s + 5s in production. The conformance
   * harness sets `CLAUDEMUX_KILL_GRACE_MS` to a short value so the
   * fake tmux (which never reports a pane gone after send-keys, and
   * has no real `on-stop.sh` to touch the marker) does not blow the
   * per-test timeout — production is unaffected.
   *
   * Returns `'graceful'` when SessionEnd was reached cleanly,
   * `'forced'` when the SIGHUP fallback fired, `'absent'` when the
   * session was gone to begin with.
   */
  private async runGracefulExit(
    sessionName: string,
    sid: string | null,
  ): Promise<'graceful' | 'forced' | 'absent'> {
    const totalGrace = killGraceMs()
    const exitWait = Math.max(50, Math.floor(totalGrace * 0.75))
    const keepWait = Math.max(50, totalGrace - exitWait)
    const markerBaseline = sid === null ? null : markerSignature(idleMarkerFor(sid))
    try {
      const sendExit = await this.env.runTmux(['send-keys', '-t', sessionName, '/exit', 'Enter'])
      if (sendExit.code !== 0) {
        return 'absent'
      }
    } catch {
      return 'absent'
    }
    if (await this.waitForExitSignal(sessionName, sid, markerBaseline, exitWait)) {
      await this.tryKillTmuxSession(sessionName)
      return 'graceful'
    }
    try {
      await this.env.runTmux(['send-keys', '-t', sessionName, 'Enter'])
    } catch {
      // best-effort; keep going to the SIGHUP fallback.
    }
    if (await this.waitForExitSignal(sessionName, sid, markerBaseline, keepWait)) {
      await this.tryKillTmuxSession(sessionName)
      return 'graceful'
    }
    await this.tryKillTmuxSession(sessionName)
    return 'forced'
  }

  /**
   * Best-effort `tmux kill-session`. Wrapped in try/catch because:
   *   - in the forced path the call is the SIGHUP fallback and a
   *     failure means tmux already lost the session, which is the
   *     same outcome we wanted;
   *   - in the graceful path the marker mtime advance means the
   *     SessionEnd hook fired, but Claude's REPL teardown plus tmux
   *     pane reap finish later — without this call the shell that
   *     replaces Claude in the pane keeps the tmux session alive
   *     indefinitely as a bare prompt.
   */
  private async tryKillTmuxSession(sessionName: string): Promise<void> {
    try {
      await this.env.runTmux(['kill-session', '-t', `=${sessionName}`])
    } catch {
      // ignore — best-effort.
    }
  }

  /**
   * Poll for any of three SessionEnd signals — `tmux has-session`
   * reports gone, the idle marker mtime advances past `baseline`, or
   * a previously absent idle marker appears — until `budgetMs`
   * elapses. Returns `true` on cleanup, `false` on timeout.
   *
   * Wall-clock is read via `process.hrtime.bigint()` so the
   * conformance harness's `vi.useFakeTimers({ toFake: ['Date'] })`
   * does not freeze the loop. The 200ms interval matches `pollReady`
   * — fast enough to surface a clean exit immediately, cheap enough
   * not to flood tmux during the dirty-prompt wait.
   *
   * When `sid` is `null` the teammate had no recorded session id, so
   * the marker file does not exist and is never touched; the loop
   * degrades cleanly to a pane-gone-only watch.
   */
  private async waitForExitSignal(
    sessionName: string,
    sid: string | null,
    baseline: MarkerSignature,
    budgetMs: number,
  ): Promise<boolean> {
    const start = process.hrtime.bigint()
    const budgetNs = BigInt(budgetMs) * 1_000_000n
    const markerPath = sid === null ? null : idleMarkerFor(sid)
    while (process.hrtime.bigint() - start < budgetNs) {
      if (markerPath !== null) {
        const current = markerSignature(markerPath)
        if (markerAdvanced(baseline, current)) return true
      }
      try {
        const present = (await this.env.runTmux(['has-session', '-t', `=${sessionName}`])).code === 0
        if (!present) return true
      } catch {
        return true
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  }

  // ─── Hot path / session-shape — real bodies in engines/claude/<verb>.ts

  async spawn(req: SpawnRequest, _ctx: EngineContext): Promise<SpawnResult> {
    const identity = reserveClaudeIdentityForLaunch({
      name: req.name,
      repo: req.repo,
      cwd: req.cwd,
      worktreeSlug: req.worktreeSlug,
      displayName: req.displayName,
      env: this.env,
      nowMs: _ctx.now(),
      verb: 'spawn',
    })
    if (identity.kind === 'already-exists') {
      return { kind: 'already-exists', existingEngine: identity.existingEngine }
    }
    if (identity.kind === 'failed') {
      return {
        kind: 'failed',
        message: rstrip(identity.result.stderr) || rstrip(identity.result.stdout),
        tmResult: identity.result,
      }
    }

    const argv: string[] = [req.name, '--repo', req.repo, '--cwd', req.cwd]
    if (req.worktreeSlug !== null) argv.push('--worktree-slug', req.worktreeSlug)
    if (req.resumeCheckpoint !== null) argv.push('--resume', req.resumeCheckpoint)
    if (req.displayName !== null) argv.push('--display-name', req.displayName)
    if (req.prompt !== null) argv.push('--prompt', req.prompt)
    // `--timeout` MUST reach the inner `tm send` on the --prompt sync path —
    // CLI parses it into `SpawnRequest.timeoutMs` for a reason. Without this,
    // `tm spawn <repo> --prompt "…" --timeout 60` silently waits 1800s and
    // the dispatcher's bg classifier never sees the 124 it was scheduling
    // against. The Codex engine already propagates timeoutMs into its own
    // `send`; this keeps the two engines symmetric.
    if (req.timeoutMs !== null) argv.push('--timeout', String(Math.round(req.timeoutMs / 1000)))
    const result = await claudeSpawn(argv, this.env)
    if (result.code !== 0) {
      if (
        identity.kind === 'reserved' &&
        !(await hasTmuxSession(this.env, tmuxSessionName(req.name)))
      ) {
        removeIdentity(req.name)
      }
      return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout), tmResult: result }
    }
    return {
      kind: 'spawned',
      name: req.name,
      tmResult: result,
      firstTurn:
        req.prompt === null
          ? null
          : { kind: 'completed', text: result.stdout, items: [], context: null, tmResult: result },
    }
  }

  async send(req: SendRequest, _ctx: EngineContext): Promise<TurnResult> {
    const argv = [req.name, '--prompt', req.prompt]
    if (req.timeoutMs !== null) argv.push('--timeout', String(Math.round(req.timeoutMs / 1000)))
    if (req.paneQuiet) argv.push('--pane-quiet')
    const result = await claudeSend(argv, this.env)
    if (result.code !== 0) {
      return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout), recoverable: false, tmResult: result }
    }
    return { kind: 'completed', text: result.stdout, items: [], context: null, tmResult: result }
  }

  async wait(req: WaitRequest, _ctx: EngineContext): Promise<TurnResult> {
    const argv = [req.name]
    if (req.timeoutMs !== null) argv.push('--timeout', String(Math.round(req.timeoutMs / 1000)))
    if (req.fresh) argv.push('--fresh')
    if (req.paneQuiet) argv.push('--pane-quiet')
    const result = await claudeWait(argv, this.env)
    if (result.code !== 0) {
      return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout), recoverable: true, tmResult: result }
    }
    return { kind: 'completed', text: result.stdout, items: [], context: null, tmResult: result }
  }

  async compact(req: CompactRequest, _ctx: EngineContext): Promise<CompactResult> {
    const argv = [req.name]
    if (req.timeoutMs !== null) argv.push('--timeout', String(Math.round(req.timeoutMs / 1000)))
    const result = await claudeCompact(argv, this.env)
    if (result.code === 0) return { kind: 'compacted', tmResult: result }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout), tmResult: result }
  }

  async resume(req: ResumeRequest, _ctx: EngineContext): Promise<ResumeResult> {
    const resumeRepo = req.repo ?? req.cwd ?? this.env.dispatcherDir
    const resumeCwd = req.cwd ?? resumeRepo
    const identity = reserveClaudeIdentityForLaunch({
      name: req.name,
      repo: resumeRepo,
      cwd: resumeCwd,
      worktreeSlug: req.worktreeSlug,
      displayName: req.displayName,
      env: this.env,
      nowMs: _ctx.now(),
      verb: 'resume',
    })
    if (identity.kind === 'already-exists') {
      return {
        kind: 'failed',
        message: `'${req.name}' already exists as a ${identity.existingEngine} teammate`,
      }
    }
    if (identity.kind === 'failed') {
      return {
        kind: 'failed',
        message: rstrip(identity.result.stderr) || rstrip(identity.result.stdout),
        tmResult: identity.result,
      }
    }

    const argv = [req.name, '--repo', resumeRepo, '--cwd', resumeCwd]
    if (req.worktreeSlug !== null) argv.push('--worktree-slug', req.worktreeSlug)
    if (req.checkpoint !== null) argv.push(req.checkpoint)
    if (req.displayName !== null) argv.push('--display-name', req.displayName)
    if (req.prompt !== null) argv.push('--prompt', req.prompt)
    const result = await claudeResume(argv, this.env)
    if (result.code === 0) return { kind: 'resumed', checkpoint: req.checkpoint, tmResult: result }
    if (
      identity.kind === 'reserved' &&
      !(await hasTmuxSession(this.env, tmuxSessionName(req.name)))
    ) {
      removeIdentity(req.name)
    }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout), tmResult: result }
  }

  async last(req: LastRequest, _ctx: EngineContext): Promise<TextResult> {
    if (req.verbose) return { kind: 'not-supported', reason: 'raw turn JSON is only available for codex teammates' }
    return claudeLast(req.name)
  }

  async ctx(req: ContextRequest, _ctx: EngineContext): Promise<ContextResult> {
    const structured = claudeCtxUsage(req.name, {
      dispatcherDir: this.env.dispatcherDir,
      projectsDir: this.env.projectsDir,
    })
    return {
      ...structured,
      tmResult: {
        code: 0,
        stdout: `${claudeCtxLine(req.name, req.windowOverride, this.env)}\n`,
        stderr: '',
      },
    }
  }

  async history(req: HistoryRequest, _ctx: EngineContext): Promise<HistoryResult> {
    // List mode shares one project-dir walk with `claudeHistoryList`;
    // detail mode keeps the path through `claudeHistory` (which itself
    // routes to `historyDetail` after a single cwd check). Both modes
    // use the runtime cwd (worktree path when applicable) — Claude
    // Code writes transcripts there.
    const cwd = req.cwd
    if (req.index === null) {
      const { tmResult, entries } = await claudeHistoryList(req.name, cwd, this.env)
      if (tmResult.code !== 0) {
        return { kind: 'failed', message: rstrip(tmResult.stderr) || rstrip(tmResult.stdout), tmResult }
      }
      return {
        kind: 'list',
        turns: [{ index: 0, startedAt: 0, summary: rstrip(tmResult.stdout) }],
        entries,
        tmResult,
      }
    }
    const result = await claudeHistory([req.name, req.index, cwd ?? ''], this.env)
    if (result.code !== 0) {
      return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout), tmResult: result }
    }
    return {
      kind: 'list',
      turns: [{ index: Number(req.index), startedAt: 0, summary: rstrip(result.stdout) }],
      entries: undefined,
      tmResult: result,
    }
  }

  async mem(req: MemoryRequest, _ctx: EngineContext): Promise<TextResult> {
    return claudeMem(req.name, {
      dispatcherDir: this.env.dispatcherDir,
      projectsDir: this.env.projectsDir,
    })
  }

  async reload(req: ReloadRequest, _ctx: EngineContext): Promise<ReloadResult> {
    const result = await claudeReload([req.name], this.env)
    if (result.code === 0) return { kind: 'reloaded', tmResult: result }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout), tmResult: result }
  }

  // ─── Diagnostic ─────────────────────────────────────────────────────

  async inspect(req: InspectRequest, _ctx: EngineContext): Promise<EngineSnapshot> {
    return {
      engine: 'claude',
      name: req.name,
      fields: {
        sid: readSid(req.name) ?? '',
        cwd: readCwd(req.name) ?? '',
        tmuxSession: tmuxSessionName(req.name),
      },
    }
  }

  async doctor(_ctx: EngineContext): Promise<DoctorSection> {
    const result = await claudeDoctor([], this.env, {
      tmWrapper: tmWrapperPath(),
      pluginJson: pluginJsonPath(),
    })
    return {
      engine: 'claude',
      findings: [
        {
          severity: result.code === 0 ? 'ok' : 'warn',
          summary: rstrip(result.stdout) || rstrip(result.stderr) || 'no doctor output',
          fix: null,
        },
      ],
    }
  }
}
