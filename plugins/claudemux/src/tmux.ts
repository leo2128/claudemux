/**
 * The `tmux` shell-out layer.
 *
 * Phase B of the strangler migration (`.agents/domains/mcp-native-orchestrator.md`
 * §12) reimplements `tm` verbs in native core code instead of shelling out to
 * `tm`. Some of those verbs still need tmux itself: migrating `tm ls` means
 * the core runs `tmux ls` and filters the output in TypeScript — it does not
 * mean tmux stops being the session backend. This module is that tmux seam,
 * the counterpart of `tm.ts` for verbs that have left the `tm` shell-out.
 *
 * The caller, not this module, decides what a non-zero exit means: `tmux ls`
 * exits non-zero merely because no server is running, which the `ls` verb
 * treats as the ordinary "no sessions" case.
 */

import { spawnCapture } from './proc'

/** The outcome of one `tmux` invocation: a faithful exit-code + stream capture. */
export interface TmuxResult {
  /** Process exit code. */
  code: number
  /** Captured standard output. */
  stdout: string
  /** Captured standard error. */
  stderr: string
}

/**
 * Runs one `tmux` invocation. Injectable: native verbs depend on this type,
 * not on the concrete function, so a conformance fixture can supply a fake
 * tmux without touching the verb logic.
 *
 * The optional `stdin` is the bytes piped to tmux's standard input — what
 * `tmux load-buffer -b <name> -` reads to stage a paste buffer.
 */
export type TmuxRunner = (
  args: readonly string[],
  options?: { stdin?: string },
) => Promise<TmuxResult>

/**
 * Resolve the `tmux` executable. `CLAUDEMUX_TMUX` overrides it (the tests
 * point it at a fake); otherwise it is plain `tmux`, found on `PATH` — the
 * same way `bin/tm` invokes tmux.
 */
export function resolveTmuxBinary(): string {
  const override = process.env.CLAUDEMUX_TMUX
  if (override && override.length > 0) return override
  return 'tmux'
}

/**
 * The production `TmuxRunner`: spawn `tmux`, forward the argument vector
 * verbatim, and capture exit code, stdout, and stderr without interpretation.
 */
export const runTmux: TmuxRunner = (args, options) =>
  spawnCapture([resolveTmuxBinary(), ...args], options)
