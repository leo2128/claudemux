/**
 * `ClaudeEngine implements Engine`. Decision 0024 §"Engine interface"
 * makes this the layer the verb dispatcher routes to; every method is
 * present, every result is a discriminated union.
 *
 * Phase 2a-1 split: the fleet-visibility methods (`list`, `status`,
 * `kill`) are implemented natively here — they are what `tm ls` /
 * `tm states` / `tm status` / `tm kill` route through after the cli
 * dispatcher gains its `EngineRegistry` wiring. The remaining twelve
 * hot-path / session-shape / diagnostic methods delegate to the
 * existing `NATIVE_VERBS` table in `native.ts` through a thin adapter
 * that converts the structured `EngineXxxRequest` into the positional
 * argv the native verb expects and the resulting `TmResult` back into
 * the discriminated engine result. Phase 2a-2 (follow-up PR) physically
 * moves that code into `engines/claude/*.ts` files and deletes
 * `native.ts`; the verb dispatch contract stays unchanged across that
 * cut.
 *
 * The capabilities record below is what verbs branch on. `atomicSend`
 * is the type literal `true` (decision 0024 §"Capabilities are
 * structured, not stringly-typed") — Claude Code's `tm send` already
 * blocks for the next Stop hook fire, so the atomic-round-trip rule
 * holds on the Claude side without further work.
 */

import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'

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
  TeammateListing,
  TeammateStatus,
  TextResult,
  TurnResult,
  WaitRequest,
} from '../types'
import type { Engine } from '../engine'
import type { NativeEnv } from '../../env'
import { claudeCompact } from './compact'
import { claudeCtxUsage } from './ctx'
import { claudeDoctor } from './doctor'
import { claudeHistory } from './history'
import { claudeLast } from './last'
import { claudeMem } from './mem'
import { claudeReload } from './reload'
import { claudeResume } from './resume'
import { claudeSend } from './send'
import { claudeSpawn } from './spawn'
import { claudeWait } from './wait'
import {
  busyMarkerFor,
  cwdFile,
  idleMarkerFor,
  lastFileFor,
  readyFile,
  sendAtFile,
  sidFile,
  TMUX_SESSION_PREFIX,
} from './persistence'
import { listingExtras } from './state'
import { pluginJsonPath, tmWrapperPath } from '../../plugin-root'

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

/** Lookup a teammate's recorded cwd; `null` if absent. */
function readCwd(name: string): string | null {
  const raw = readIfNonEmpty(cwdFile(name))
  return raw === null ? null : rstrip(raw)
}

/** Whether the teammate's tmux session is alive. */
async function hasTmuxSession(env: NativeEnv, sessionName: string): Promise<boolean> {
  try {
    return (await env.runTmux(['has-session', '-t', `=${sessionName}`])).code === 0
  } catch {
    return false
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

  /** The Claude engine carries the `NativeEnv` only because Phase 2a-1 still
   *  delegates 12 of its 16 methods to `NATIVE_VERBS`. Phase 2a-2 inlines
   *  the implementations and shrinks the constructor accordingly. */
  constructor(private readonly env: NativeEnv) {}

  // ─── Fleet visibility — Phase 2a-1 real impls ──────────────────────

  async list(ctx: EngineContext): Promise<readonly TeammateListing[]> {
    let listing = ''
    try {
      listing = (await this.env.runTmux(['ls'])).stdout
    } catch {
      listing = ''
    }
    // Sample `now` once per `list()` call so a multi-row scan reports the
    // same clock reading across every teammate's LAST age, matching the
    // legacy `cmd_states`'s pre-loop `now=$(date +%s)`.
    const now = Math.floor(ctx.now() / 1000)
    const out: TeammateListing[] = []
    for (const line of listing.split('\n')) {
      const colon = line.indexOf(':')
      const session = colon >= 0 ? line.slice(0, colon) : line
      if (!session.startsWith(TMUX_SESSION_PREFIX)) continue
      // Strip the tmux prefix but keep the raw session-name suffix as the
      // listing's `name`. Decoding `__` → `/` here would mis-identify a
      // legacy single-segment teammate like `flow__1` as a nested name
      // `flow/1`; listings therefore surface tmux session names verbatim.
      // A future iteration may read the base TeammateRecord JSON instead.
      const name = session.slice(TMUX_SESSION_PREFIX.length)
      const extras = listingExtras(name, now)
      out.push({
        name,
        engine: 'claude',
        state: deriveState(name),
        cwd: readCwd(name) ?? '',
        displayName: null,
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
    const sessionName = `${TMUX_SESSION_PREFIX}${req.name.replace(/\//g, '__')}`
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
    const sessionName = `${TMUX_SESSION_PREFIX}${req.name.replace(/\//g, '__')}`
    const sid = readSid(req.name)
    if (sid !== null) {
      // Clear the three hook artifacts together — idle marker, .last, .busy.
      rmSync(idleMarkerFor(sid), { force: true })
      rmSync(lastFileFor(sid), { force: true })
      rmSync(busyMarkerFor(sid), { force: true })
    }
    for (const file of [sidFile(req.name), sendAtFile(req.name), readyFile(req.name), cwdFile(req.name)]) {
      rmSync(file, { force: true })
    }

    let running = false
    try {
      running = (await this.env.runTmux(['has-session', '-t', `=${sessionName}`])).code === 0
    } catch {
      running = false
    }
    if (!running) return { kind: 'not-found' }

    try {
      await this.env.runTmux(['kill-session', '-t', `=${sessionName}`])
    } catch (err) {
      return { kind: 'failed', message: err instanceof Error ? err.message : String(err) }
    }
    return { kind: 'killed' }
  }

  // ─── Hot path / session-shape — real bodies in engines/claude/<verb>.ts

  async spawn(req: SpawnRequest, _ctx: EngineContext): Promise<SpawnResult> {
    const argv: string[] = [req.name]
    if (req.displayName !== null) argv.push('--task', req.displayName)
    if (req.prompt !== null) argv.push('--prompt', req.prompt)
    const result = await claudeSpawn(argv, this.env)
    if (result.code !== 0) {
      return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout) }
    }
    return {
      kind: 'spawned',
      name: req.name,
      firstTurn:
        req.prompt === null
          ? null
          : { kind: 'completed', text: result.stdout, items: [], context: null },
    }
  }

  async send(req: SendRequest, _ctx: EngineContext): Promise<TurnResult> {
    const argv = [req.name, '--prompt', req.prompt]
    if (req.timeoutMs !== null) argv.push('--timeout', String(Math.round(req.timeoutMs / 1000)))
    const result = await claudeSend(argv, this.env)
    if (result.code !== 0) {
      return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout), recoverable: false }
    }
    return { kind: 'completed', text: result.stdout, items: [], context: null }
  }

  async wait(req: WaitRequest, _ctx: EngineContext): Promise<TurnResult> {
    const argv = [req.name]
    if (req.timeoutMs !== null) argv.push('--timeout', String(Math.round(req.timeoutMs / 1000)))
    const result = await claudeWait(argv, this.env)
    if (result.code !== 0) {
      return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout), recoverable: true }
    }
    return { kind: 'completed', text: result.stdout, items: [], context: null }
  }

  async compact(req: CompactRequest, _ctx: EngineContext): Promise<CompactResult> {
    const result = await claudeCompact([req.name], this.env)
    if (result.code === 0) return { kind: 'compacted' }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout) }
  }

  async resume(req: ResumeRequest, _ctx: EngineContext): Promise<ResumeResult> {
    const result = await claudeResume([req.name, req.checkpoint], this.env)
    if (result.code === 0) return { kind: 'resumed', checkpoint: req.checkpoint }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout) }
  }

  async last(req: LastRequest, _ctx: EngineContext): Promise<TextResult> {
    return claudeLast(req.name)
  }

  async ctx(req: ContextRequest, _ctx: EngineContext): Promise<ContextResult> {
    return claudeCtxUsage(req.name, {
      dispatcherDir: this.env.dispatcherDir,
      projectsDir: this.env.projectsDir,
    })
  }

  async history(req: HistoryRequest, _ctx: EngineContext): Promise<HistoryResult> {
    const argv = [req.name]
    if (req.index !== null) argv.push(String(req.index))
    const result = await claudeHistory(argv, this.env)
    if (result.code === 0) {
      // Engine adapter still hands the raw text back via the `list` arm
      // with one synthetic turn; a richer parse on the structured side
      // is a separate change.
      return {
        kind: 'list',
        turns: [{ index: req.index ?? 0, startedAt: 0, summary: rstrip(result.stdout) }],
      }
    }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout) }
  }

  async mem(req: MemoryRequest, _ctx: EngineContext): Promise<TextResult> {
    return claudeMem(req.name, {
      dispatcherDir: this.env.dispatcherDir,
      projectsDir: this.env.projectsDir,
    })
  }

  async reload(req: ReloadRequest, _ctx: EngineContext): Promise<ReloadResult> {
    const result = await claudeReload([req.name], this.env)
    if (result.code === 0) return { kind: 'reloaded' }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout) }
  }

  // ─── Diagnostic ─────────────────────────────────────────────────────

  async inspect(req: InspectRequest, _ctx: EngineContext): Promise<EngineSnapshot> {
    return {
      engine: 'claude',
      name: req.name,
      fields: {
        sid: readSid(req.name) ?? '',
        cwd: readCwd(req.name) ?? '',
        tmuxSession: `${TMUX_SESSION_PREFIX}${req.name.replace(/\//g, '__')}`,
      },
    }
  }

  async doctor(_ctx: EngineContext): Promise<DoctorSection> {
    // Path math must run from a module that sits at the same depth as
    // the bundled `core/dist/cli.mjs`; `plugin-root.ts` is that module.
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
