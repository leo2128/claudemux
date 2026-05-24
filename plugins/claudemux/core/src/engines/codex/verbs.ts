/**
 * Thin CLI compatibility wrappers for the Codex engine.
 *
 * Phase 2b moves the runtime implementation behind `CodexEngine`. The
 * native dispatcher still speaks the historical `TmResult` shape, so this
 * module is deliberately small: parse-free adapter functions in, structured
 * Engine calls out, existing CLI formatting back.
 */

import { closeSync, openSync, rmSync, writeSync } from 'node:fs'

import type { Engine } from '../engine'
import type { EngineContext, TeammateListing } from '../types'
import type { ThreadStartResponse } from '../../codex-protocol/v2/ThreadStartResponse.js'
import type { TmResult } from '../../tm'
import { formatTurn } from '../../verbs/format'
import { CodexEngine, openInitializedCodexClient } from './engine.js'
import { runTurn, subscribeTurnCollection } from './events.js'
import {
  daemonAlive,
  listDaemons,
  readDaemonState,
  touchLastSeen,
} from './supervisor.js'
import {
  codexBorrowLockFile,
  readBaseRecord,
} from './persistence.js'

/** Per-codex-verb `die` — mirrors the `tm: <msg>` wire shape native.ts uses. */
function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

function engineContext(): EngineContext {
  return { now: () => Date.now(), env: process.env }
}

function resolveEngine(engine: Engine | undefined): Engine {
  return engine ?? new CodexEngine()
}

function timeoutMsFromSeconds(timeoutSec: number | null): number | null {
  return timeoutSec === null ? null : timeoutSec * 1000
}

/** Names a codex teammate? Verbs check this to fork into this module. */
export function isCodexTarget(name: string): boolean {
  if (name.startsWith('codex-') || name.startsWith('codex/')) return true
  const base = readBaseRecord(name)
  if (base?.engine === 'codex') return true
  return false
}

export interface CodexSpawnOptions {
  readonly cwd?: string
  readonly prompt?: string | null
  readonly timeoutSec?: number | null
  readonly displayName?: string | null
  readonly engine?: Engine
}

/**
 * `tm spawn <codex-name>` — start a per-teammate codex daemon and optionally
 * run the first prompt through the Engine contract.
 */
export async function codexSpawn(
  name: string,
  opts: CodexSpawnOptions = {},
): Promise<TmResult> {
  const engine = resolveEngine(opts.engine)
  const result = await engine.spawn(
    {
      name,
      cwd: opts.cwd ?? process.cwd(),
      prompt: opts.prompt ?? null,
      timeoutMs: timeoutMsFromSeconds(opts.timeoutSec ?? null),
      displayName: opts.displayName ?? null,
    },
    engineContext(),
  )

  switch (result.kind) {
    case 'spawned': {
      const state = readDaemonState(name)
      let stderr =
        state === null
          ? `spawned: ${name}\n`
          : `spawned: ${name} (pid=${state.pid}, socket=${state.socketPath})\n`
      if (result.firstTurn === null) return { code: 0, stdout: '', stderr }
      const turn = formatTurn(result.firstTurn)
      return {
        code: turn.code,
        stdout: turn.stdout,
        stderr: stderr + turn.stderr,
      }
    }
    case 'already-exists':
      return die(`codex teammate '${name}' already exists (engine=${result.existingEngine})`)
    case 'failed':
      return die(result.message)
  }
}

/** `tm send <codex-name> --prompt ...` — atomic turn by default. */
export async function codexSend(
  name: string,
  prompt: string,
  opts: { readonly timeoutSec?: number | null; readonly engine?: Engine } = {},
): Promise<TmResult> {
  const result = await resolveEngine(opts.engine).send(
    {
      name,
      prompt,
      timeoutMs: timeoutMsFromSeconds(opts.timeoutSec ?? null),
    },
    engineContext(),
  )
  return formatTurn(result)
}

/** `tm wait <codex-name>` — wait for the next turn/completed notification. */
export async function codexWait(
  name: string,
  opts: { readonly timeoutSec?: number | null; readonly engine?: Engine } = {},
): Promise<TmResult> {
  const result = await resolveEngine(opts.engine).wait(
    { name, recoverFor: null, timeoutMs: timeoutMsFromSeconds(opts.timeoutSec ?? null) },
    engineContext(),
  )
  return formatTurn(result)
}

/**
 * `tm kill <codex-name>` — SIGTERM the daemon and remove its Engine base
 * record. The historical CLI shape is idempotent on missing teammates.
 */
export async function codexKill(
  name: string,
  opts: { readonly engine?: Engine } = {},
): Promise<TmResult> {
  const state = readDaemonState(name)
  const base = readBaseRecord(name)
  const result = await resolveEngine(opts.engine).kill({ name }, engineContext())
  if (result.kind === 'failed') return die(result.message)
  if (result.kind === 'not-found' || (state === null && base === null)) {
    return {
      code: 0,
      stdout: '',
      stderr: `no codex teammate '${name}' to kill (already gone)\n`,
    }
  }
  return {
    code: 0,
    stdout: '',
    stderr: state === null ? `killed: ${name}\n` : `killed: ${name} (was pid=${state.pid})\n`,
  }
}

/** Codex rows for `tm ls`, rendered in the legacy tmux-listing style. */
export async function codexListLines(engine?: Engine): Promise<readonly string[]> {
  const rows = await resolveEngine(engine).list(engineContext())
  return rows.map((row) => formatListLine(row))
}

function formatListLine(row: TeammateListing): string {
  const pid = row.extras['pid'] === undefined || row.extras['pid'] === '' ? '?' : row.extras['pid']
  return `${row.name}: codex daemon (${row.state}; pid=${pid})`
}

/** Codex rows for `tm states`, using the legacy REPO/SID/BUSY/LAST/PREVIEW columns. */
export async function codexStateRows(
  nowSec: number,
  engine?: Engine,
): Promise<readonly string[][]> {
  const rows = await resolveEngine(engine).list(engineContext())
  return rows.map((row) => {
    const thread = row.extras['thread'] ?? ''
    const lastSeen = row.extras['lastSeen'] ?? ''
    const pid = row.extras['pid'] ?? ''
    const lastSeenSec = Number.parseInt(lastSeen, 10)
    const last =
      Number.isFinite(lastSeenSec) ? `${Math.max(0, nowSec - lastSeenSec)}s` : '-'
    const preview = pid.length === 0 ? 'codex daemon' : `pid=${pid}`
    return [
      row.name,
      thread.length === 0 ? 'codex' : thread.slice(0, 8),
      row.state === 'busy' ? 'yes' : row.state === 'idle' ? 'no' : '?',
      last,
      preview,
    ]
  })
}

/** Compact status view for codex teammates, used by the native status verb. */
export async function codexStatus(name: string, engine?: Engine): Promise<TmResult> {
  const result = await resolveEngine(engine).status({ name, lines: null }, engineContext())
  switch (result.kind) {
    case 'present': {
      const lines = [
        `codex teammate: ${result.name}`,
        `engine:          ${result.engine}`,
        `state:           ${result.state}`,
        `cwd:             ${result.cwd}`,
      ]
      for (const [key, value] of Object.entries(result.diagnostics)) {
        if (value.length > 0) lines.push(`${key}: ${value}`)
      }
      return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
    }
    case 'not-found':
      return die(`no such codex teammate: ${name}`)
    case 'failed':
      return die(`codex status on '${name}' failed: ${result.message}`)
  }
}

function tryBorrow(name: string): boolean {
  try {
    const fd = openSync(codexBorrowLockFile(name), 'wx', 0o600)
    try {
      writeSync(fd, `${process.pid}\n`)
    } finally {
      closeSync(fd)
    }
    return true
  } catch {
    return false
  }
}

function releaseBorrow(name: string): void {
  rmSync(codexBorrowLockFile(name), { force: true })
}

/**
 * `tm ask "<prompt>"` — borrow one live codex teammate from the pool, run an
 * ephemeral thread, and release the teammate.
 */
export async function codexAsk(prompt: string): Promise<TmResult> {
  if (prompt.length === 0) return die('usage: tm ask "<prompt>"')

  const candidates = listDaemons()
  if (candidates.length === 0) {
    return die("no codex teammates available — run 'tm spawn codex-1' (or similar) first")
  }

  let borrowed: string | null = null
  let aliveCount = 0
  for (const name of candidates) {
    if (!daemonAlive(name)) continue
    aliveCount += 1
    if (tryBorrow(name)) {
      borrowed = name
      break
    }
  }

  if (borrowed === null) {
    if (aliveCount === 0) {
      return die(`all ${candidates.length} codex teammate(s) are dead — 'tm doctor' will reap them`)
    }
    return die(`all ${aliveCount} alive codex teammate(s) are busy — retry, or spawn another`)
  }

  const borrowedName = borrowed
  let client: Awaited<ReturnType<typeof openInitializedCodexClient>> | null = null
  try {
    client = await openInitializedCodexClient(borrowedName)
    const resp = await client.request<'thread/start', ThreadStartResponse>('thread/start', {
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    })
    const completed = await runTurn(client, resp.thread.id, prompt, { wait: true, cwd: null })
    touchLastSeen(borrowedName)
    return {
      code: 0,
      stdout: JSON.stringify(completed, null, 2) + '\n',
      stderr: '',
    }
  } catch (e) {
    return die(
      `codex ask on '${borrowedName}' failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  } finally {
    if (client !== null) client.close()
    releaseBorrow(borrowedName)
  }
}

export { subscribeTurnCollection }
export type { TurnCompletedNotification } from './events.js'
