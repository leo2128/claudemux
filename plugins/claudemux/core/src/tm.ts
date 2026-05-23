/**
 * The `TmResult` shape — what every `tm` verb returns — and `resolveTmBinary`,
 * which locates the user-installed `tm` PATH entry.
 *
 * Stage 3c retired the Bash `bin/tm`; the orchestrator is now a pure Node CLI
 * and no verb shells out to `tm`. The runtime shell-out functions that used to
 * live here (`runTm` / `runTmRaw`) are gone with it.
 *
 * Two seams remain useful and keep their home in this module:
 *
 *  - `TmResult` / `TmRunOptions` — the call shape every `NativeVerb` produces
 *    and the optional stdin a verb may consume. Module-public types so the
 *    CLI front end and the conformance harness see the same contract.
 *  - `resolveTmBinary` — used by the live-teammate integration harness to
 *    locate the PATH entry it drives. It honors `CLAUDEMUX_TM`, so the same
 *    harness can be re-aimed at a dev launcher (`core/bin/tm`) or any other
 *    `tm` binary without code change.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The outcome of one `tm` verb: a faithful exit-code + stream capture. */
export interface TmResult {
  /** Process exit code. */
  code: number
  /** Captured standard output. */
  stdout: string
  /** Captured standard error. */
  stderr: string
}

/** Options for one verb invocation. */
export interface TmRunOptions {
  /** Text to feed on stdin — needed by stdin-reading verbs such as `archive`. */
  stdin?: string
}

/**
 * Resolve the `tm` executable. `CLAUDEMUX_TM` overrides it (the live-teammate
 * suite points it at `core/bin/tm` to drive native verbs through the dev
 * launcher); otherwise it is the `bin/tm` shipped alongside this core in the
 * claudemux plugin.
 */
export function resolveTmBinary(): string {
  const override = process.env.CLAUDEMUX_TM
  if (override && override.length > 0) return override
  // core/src/tm.ts → plugins/claudemux/bin/tm
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'tm')
}
