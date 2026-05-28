import type { Engine } from '../engine'
import type { TmResult } from '../../tm'
import { formatTurn } from '../../verbs/format'
import { readDaemonState } from './supervisor.js'
import { readBaseRecord } from './persistence.js'
import {
  die,
  engineContext,
  resolveEngine,
  timeoutMsFromSeconds,
  validateCodexName,
} from './verb-common.js'

export interface CodexSpawnOptions {
  readonly cwd?: string
  readonly prompt?: string | null
  readonly timeoutSec?: number | null
  readonly displayName?: string | null
  readonly engine?: Engine
}

/**
 * `tm spawn <name> --engine codex` — start a per-teammate codex daemon and
 * optionally run the first prompt through the Engine contract.
 */
export async function codexSpawn(
  name: string,
  opts: CodexSpawnOptions = {},
): Promise<TmResult> {
  const invalidName = validateCodexName(name)
  if (invalidName !== null) return invalidName
  const engine = resolveEngine(opts.engine)
  const cwd = opts.cwd ?? process.cwd()
  const result = await engine.spawn(
    {
      name,
      repo: cwd,
      cwd,
      worktreeSlug: null,
      resumeCheckpoint: null,
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
