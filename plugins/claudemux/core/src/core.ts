/**
 * The verb dispatch core.
 *
 * `runVerb` is the one place that decides, per verb, whether a `tm` verb runs
 * as native TypeScript (`native.ts`) or shells out to the Bash `tm` (`tm.ts`).
 * The migration moves verbs from the shell-out into native code one at a time;
 * `runVerb` consults `NATIVE_VERBS` per call. The CLI front end (`cli.ts`)
 * runs every verb through it.
 */

import { isNativeVerb, NATIVE_VERBS, type NativeEnv, triggersTmHelp } from './native'
import type { TmResult, TmRunOptions } from './tm'

/**
 * Run one `tm` verb and return its `TmResult`. A migrated verb runs natively
 * (`native.ts`); every other verb shells out to `tm`. Either way the verb
 * produces the same `{code, stdout, stderr}` shape — that is what keeps the
 * migration drop-in.
 *
 * A `--help` invocation is the exception: `tm`'s own dispatcher prints the
 * per-verb help and a native handler carries no help text, so an argument
 * vector that would trigger `tm`'s help pre-scan shells out even for a
 * migrated verb.
 *
 * `argv` is the verb's full argument vector.
 */
export async function runVerb(
  verb: string,
  argv: string[],
  options: TmRunOptions | undefined,
  env: NativeEnv,
): Promise<TmResult> {
  const native =
    isNativeVerb(verb) && !triggersTmHelp(argv) ? NATIVE_VERBS[verb] : undefined
  return native ? native(argv, options, env) : env.runTm(verb, argv, options)
}
