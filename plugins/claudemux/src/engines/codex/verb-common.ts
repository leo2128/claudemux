import type { Engine } from '../engine'
import type { EngineContext } from '../types'
import type { TmResult } from '../../tm'
import { validateTeammateName } from '../../identity/name.js'
import { CodexEngine } from './engine.js'

/** Per-codex-verb `die` — mirrors the `tm: <msg>` wire shape native.ts uses. */
export function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

export function engineContext(): EngineContext {
  return { now: () => Date.now(), env: process.env }
}

export function resolveEngine(engine: Engine | undefined): Engine {
  return engine ?? new CodexEngine()
}

export function timeoutMsFromSeconds(timeoutSec: number | null): number | null {
  return timeoutSec === null ? null : timeoutSec * 1000
}

function codexNameValidationError(name: string): string | null {
  const validation = validateTeammateName(name)
  return validation.kind === 'ok'
    ? null
    : `invalid codex teammate name '${name}': ${validation.reason}`
}

export function validateCodexName(name: string): TmResult | null {
  const message = codexNameValidationError(name)
  return message === null ? null : die(message)
}
