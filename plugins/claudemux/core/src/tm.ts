/**
 * The `tm` shell-out layer.
 *
 * Phase A of the strangler migration (see
 * `.agents/domains/mcp-native-orchestrator.md` §12): the resident core does
 * not reimplement any teammate operation — it shells out to the unmodified
 * `bin/tm` for every verb. This module is that single shell-out seam; every
 * verb the core exposes routes through `runTm`.
 *
 * Keeping the shell-out in one place is what makes Phase B possible: a verb
 * is migrated into native core code by replacing one `runTm` call site, with
 * the conformance harness pinning it to the behavior captured here.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { spawnCapture } from './proc'

/** The outcome of one `tm` invocation: a faithful exit-code + stream capture. */
export interface TmResult {
  /** Process exit code. */
  code: number
  /** Captured standard output. */
  stdout: string
  /** Captured standard error. */
  stderr: string
}

/** Options for one `tm` invocation. */
export interface TmRunOptions {
  /** Text to feed on stdin — needed by stdin-reading verbs such as `archive`. */
  stdin?: string
}

/**
 * Runs one `tm` verb. Injectable: the core depends on this type, not on the
 * concrete function, so tests drive every verb against a fake `tm`.
 */
export type TmRunner = (
  verb: string,
  args: readonly string[],
  options?: TmRunOptions,
) => Promise<TmResult>

/**
 * Resolve the `tm` executable. `CLAUDEMUX_TM` overrides it (the tests point it
 * at a fake); otherwise it is the `bin/tm` shipped alongside this core in the
 * claudemux plugin.
 */
export function resolveTmBinary(): string {
  const override = process.env.CLAUDEMUX_TM
  if (override && override.length > 0) return override
  // core/src/tm.ts → plugins/claudemux/bin/tm
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'tm')
}

/**
 * Runs `tm` with a raw argument vector — `tm` followed by `args` verbatim,
 * with no verb/arguments split. The CLI front end uses this for an argv that
 * is not a verb invocation (a bare `tm`, a global flag): bash `tm` stays the
 * authority on its own help and error output.
 */
export type RawTmRunner = (
  args: readonly string[],
  options?: TmRunOptions,
) => Promise<TmResult>

/**
 * The production `RawTmRunner`: spawn `tm`, forward the argument vector and
 * any stdin verbatim, and capture exit code, stdout, and stderr without
 * interpretation — a faithful pass-through; interpreting `tm`'s output is a
 * per-verb migration task.
 */
export const runTmRaw: RawTmRunner = (args, options) =>
  spawnCapture([resolveTmBinary(), ...args], options)

/**
 * The production `TmRunner`: a verb invocation of `tm`, which is `runTmRaw`
 * with the verb as the first argument.
 */
export const runTm: TmRunner = (verb, args, options) =>
  runTmRaw([verb, ...args], options)
