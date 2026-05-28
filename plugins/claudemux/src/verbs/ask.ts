/**
 * `tm ask "<prompt>"` — borrow an idle named codex teammate, run one
 * turn on a fresh thread, return the teammate. The "pool" is the
 * spawned Codex-engine set; this verb does not name a teammate. Always
 * routes into the codex driver, never into the tmux path.
 *
 * Codex-only by definition (decision multi-engine-tui-architecture): a claude teammate is named,
 * so a "borrow from the pool" verb belongs to the engine whose
 * teammates are pool-shaped.
 */

import { codexAsk } from '../engines/codex/verbs'
import type { TmResult } from '../tm'

export async function askVerb(args: readonly string[]): Promise<TmResult> {
  if (args.length === 0) {
    return { code: 1, stdout: '', stderr: 'tm: usage: tm ask "<prompt>"\n' }
  }
  if (args.length > 1) {
    return {
      code: 1,
      stdout: '',
      stderr:
        `tm: tm ask: takes exactly one positional argument (the prompt) — ` +
        `got ${args.length}\n`,
    }
  }
  return codexAsk(args[0] ?? '')
}
