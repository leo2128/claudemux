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
import type { TmResult, TmRunOptions } from '../../tm'
import { NATIVE_VERBS, type NativeEnv } from '../../native'
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

/**
 * Adapter — call a `NATIVE_VERBS[verb]` handler with positional argv and
 * an env, return the raw `TmResult`. Phase 2a-1 routes the twelve
 * non-fleet methods through this; Phase 2a-2 will inline the underlying
 * code into engines/claude/* and drop this seam.
 */
async function callNative(
  env: NativeEnv,
  verb: string,
  argv: readonly string[],
  options?: TmRunOptions,
): Promise<TmResult> {
  const handler = NATIVE_VERBS[verb]
  if (handler === undefined) {
    return { code: 1, stdout: '', stderr: `tm: native verb not registered: ${verb}\n` }
  }
  return handler(argv, options, env)
}

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

  async list(_ctx: EngineContext): Promise<readonly TeammateListing[]> {
    let listing = ''
    try {
      listing = (await this.env.runTmux(['ls'])).stdout
    } catch {
      listing = ''
    }
    const out: TeammateListing[] = []
    for (const line of listing.split('\n')) {
      const colon = line.indexOf(':')
      const session = colon >= 0 ? line.slice(0, colon) : line
      if (!session.startsWith(TMUX_SESSION_PREFIX)) continue
      // Strip the tmux prefix but keep the raw session-name suffix as the
      // listing's `name`. Decoding `__` → `/` here would mis-identify a
      // legacy single-segment teammate like `flow__1` as a nested name
      // `flow/1`; Phase 2a-1 listings therefore surface tmux session names
      // verbatim. Phase 2a-2 reads the base TeammateRecord JSON which
      // holds the unambiguous raw name and replaces this fallback.
      const name = session.slice(TMUX_SESSION_PREFIX.length)
      out.push({
        name,
        engine: 'claude',
        state: deriveState(name),
        cwd: readCwd(name) ?? '',
        displayName: null,
        extras: {},
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

  // ─── Hot path / session-shape — Phase 2a-1 delegate to NATIVE_VERBS ─

  async spawn(req: SpawnRequest, _ctx: EngineContext): Promise<SpawnResult> {
    const argv: string[] = [req.name]
    if (req.displayName !== null) argv.push('--task', req.displayName)
    if (req.prompt !== null) argv.push('--prompt', req.prompt)
    const result = await callNative(this.env, 'spawn', argv)
    if (result.code !== 0) return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout) }
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
    const result = await callNative(this.env, 'send', argv)
    if (result.code !== 0) {
      return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout), recoverable: false }
    }
    return { kind: 'completed', text: result.stdout, items: [], context: null }
  }

  async wait(req: WaitRequest, _ctx: EngineContext): Promise<TurnResult> {
    const argv = [req.name]
    if (req.timeoutMs !== null) argv.push('--timeout', String(Math.round(req.timeoutMs / 1000)))
    const result = await callNative(this.env, 'wait', argv)
    if (result.code !== 0) {
      return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout), recoverable: true }
    }
    return { kind: 'completed', text: result.stdout, items: [], context: null }
  }

  async compact(req: CompactRequest, _ctx: EngineContext): Promise<CompactResult> {
    const result = await callNative(this.env, 'compact', [req.name])
    if (result.code === 0) return { kind: 'compacted' }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout) }
  }

  async resume(req: ResumeRequest, _ctx: EngineContext): Promise<ResumeResult> {
    const result = await callNative(this.env, 'resume', [req.name, '--sid', req.checkpoint])
    if (result.code === 0) return { kind: 'resumed', checkpoint: req.checkpoint }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout) }
  }

  async last(req: LastRequest, _ctx: EngineContext): Promise<TextResult> {
    const result = await callNative(this.env, 'last', [req.name])
    if (result.code === 0) return { kind: 'text', text: result.stdout }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout) }
  }

  async ctx(req: ContextRequest, _ctx: EngineContext): Promise<ContextResult> {
    const result = await callNative(this.env, 'ctx', [req.name])
    if (result.code === 0) {
      // Parse the `tm ctx` line, which is intentionally not structured today.
      // Phase 2a-2's claude-context.ts will return real numbers.
      const match = /\b(\d+)\/(\d+)\b/.exec(result.stdout)
      if (match) {
        const used = Number(match[1])
        const total = Number(match[2])
        return { kind: 'usage', tokensUsed: used, tokensTotal: total, pct: Math.floor((used * 100) / total) }
      }
      return { kind: 'not-supported', reason: 'could not parse usage line' }
    }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout) }
  }

  async history(req: HistoryRequest, _ctx: EngineContext): Promise<HistoryResult> {
    const argv = [req.name]
    if (req.index !== null) argv.push(String(req.index))
    const result = await callNative(this.env, 'history', argv)
    if (result.code === 0) {
      // Phase 2a-1 hands the raw text back via the `list` arm with one synthetic
      // turn; Phase 2a-2 replaces this with real parsing.
      return {
        kind: 'list',
        turns: [{ index: req.index ?? 0, startedAt: 0, summary: rstrip(result.stdout) }],
      }
    }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout) }
  }

  async mem(req: MemoryRequest, _ctx: EngineContext): Promise<TextResult> {
    const result = await callNative(this.env, 'mem', [req.name])
    if (result.code === 0) return { kind: 'text', text: result.stdout }
    return { kind: 'failed', message: rstrip(result.stderr) || rstrip(result.stdout) }
  }

  async reload(req: ReloadRequest, _ctx: EngineContext): Promise<ReloadResult> {
    const result = await callNative(this.env, 'reload', [req.name])
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
    const result = await callNative(this.env, 'doctor', [])
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
