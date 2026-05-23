/**
 * `tm spawn <name> --engine <k>` — atomic teammate spawn. Decision
 * 0024 §"Round-trips are atomic by default" makes a `--prompt` an
 * atomic first turn; `--no-wait` is gone. Engine selection is the
 * explicit `--engine` flag (decision 0023 §1, carried forward).
 *
 * Phase 1 lands the skeleton: parse a `SpawnRequest`, look the engine
 * up in the registry, dispatch. With the Phase 1 empty registry, the
 * verb falls through to `noEngineRegistered()`; Phase 2 registers the
 * concrete Claude / Codex engines and the spawn round-trip becomes
 * live.
 */

import { noEngineRegistered } from './format'
import type {
  EngineKind,
  SpawnRequest,
  SpawnResult,
  TeammateName,
} from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'

export interface SpawnArgs {
  readonly name: TeammateName
  readonly engine: EngineKind
  readonly cwd: string
  readonly prompt: string | null
  readonly timeoutMs: number | null
  readonly displayName: string | null
}

export async function spawnVerb(args: SpawnArgs, ctx: VerbContext): Promise<TmResult> {
  const engine = ctx.engines.get(args.engine)
  if (engine === undefined) return noEngineRegistered()

  const req: SpawnRequest = {
    name: args.name,
    cwd: args.cwd,
    prompt: args.prompt,
    timeoutMs: args.timeoutMs,
    displayName: args.displayName,
  }
  const result: SpawnResult = await engine.spawn(req, ctx.engineContext)

  switch (result.kind) {
    case 'spawned':
      return { code: 0, stdout: `spawned: ${result.name}\n`, stderr: '' }
    case 'already-exists':
      return {
        code: 1,
        stdout: '',
        stderr: `tm: spawn: '${args.name}' already exists as a ${result.existingEngine} teammate\n`,
      }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: spawn: ${result.message}\n` }
  }
}
