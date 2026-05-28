/**
 * Public CLI library surface.
 *
 * The implementation lives under `cli/`: `dispatch.ts` owns verb routing,
 * `parse.ts` owns shared CLI argument parsing, `errors.ts` owns TmResult
 * error/help shapes, and `context.ts` owns production backend wiring.
 * This file stays as the stable import path for `main.ts` and tests.
 */

export { productionEnv } from './cli/context'
export { runCli } from './cli/dispatch'
export { triggersHelp } from './cli/parse'
