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

import { join } from 'node:path'

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
  return join(import.meta.dir, '..', '..', 'bin', 'tm')
}

/**
 * The production `TmRunner`: spawn `tm`, forward the argument vector and any
 * stdin verbatim, and capture exit code, stdout, and stderr without
 * interpretation. The core's job in Phase A is to be a faithful pass-through;
 * interpreting `tm`'s output is a per-verb Phase B task.
 */
export const runTm: TmRunner = async (verb, args, options) => {
  const proc = Bun.spawn([resolveTmBinary(), verb, ...args], {
    stdin: options?.stdin != null ? new TextEncoder().encode(options.stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}
