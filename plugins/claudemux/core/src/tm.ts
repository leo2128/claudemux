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
 *    harness can be re-aimed at any custom `tm` binary without code change.
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
 * Exit code for "sync wait expired but the teammate is still running" —
 * the verb wanted a reply within `--timeout`, the timer elapsed, but the
 * underlying teammate (Claude REPL, codex daemon) was not declared dead.
 *
 * The value (124) is the GNU `timeout(1)` convention: callers that already
 * branch on `124` for `timeout` behave the same on `tm`. The dispatcher's
 * bg-task wrapper uses it to distinguish "TM is gone, retry from spawn"
 * (exit 1) from "TM is still working, keep watching with `tm wait`" (exit
 * 124). Exit 0 still means "got the reply within the window".
 */
export const EXIT_SYNC_WAIT_EXPIRED = 124

/**
 * Resolve the `tm` executable. `CLAUDEMUX_TM` overrides it (the live-teammate
 * suite points it at any custom launcher this way); otherwise it is the
 * `bin/tm` shipped alongside this core in the claudemux plugin.
 */
export function resolveTmBinary(): string {
  const override = process.env.CLAUDEMUX_TM
  if (override && override.length > 0) return override
  // core/src/tm.ts → plugins/claudemux/bin/tm
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'tm')
}
