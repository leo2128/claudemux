import type { Engine } from '../engine'
import type { TmResult } from '../../tm'
import { formatTurn } from '../../verbs/format'
import {
  engineContext,
  resolveEngine,
  timeoutMsFromSeconds,
  validateCodexName,
} from './verb-common.js'

/** `tm send <codex-name> --prompt ...` — atomic turn by default. */
export async function codexSend(
  name: string,
  prompt: string,
  opts: { readonly timeoutSec?: number | null; readonly engine?: Engine } = {},
): Promise<TmResult> {
  const invalidName = validateCodexName(name)
  if (invalidName !== null) return invalidName
  const result = await resolveEngine(opts.engine).send(
    {
      name,
      prompt,
      timeoutMs: timeoutMsFromSeconds(opts.timeoutSec ?? null),
      paneQuiet: false,
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
  const invalidName = validateCodexName(name)
  if (invalidName !== null) return invalidName
  const result = await resolveEngine(opts.engine).wait(
    {
      name,
      recoverFor: null,
      timeoutMs: timeoutMsFromSeconds(opts.timeoutSec ?? null),
      fresh: false,
      paneQuiet: false,
    },
    engineContext(),
  )
  return formatTurn(result)
}
