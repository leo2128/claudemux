import { HELP_TEXTS, OVERVIEW_HELP } from '../help'
import type { TmResult } from '../tm'

/** A `tm: <message>` error result, exit 1. */
export function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

/** A removed verb's migration message + exit 2. */
export function removedVerb(message: string): TmResult {
  return { code: 2, stdout: '', stderr: message }
}

/** The unknown-subcommand error: stderr line + overview on stdout + exit 1. */
export function unknownVerb(verb: string): TmResult {
  return { code: 1, stdout: OVERVIEW_HELP, stderr: `tm: unknown subcommand: ${verb}\n` }
}

/**
 * Route a `tm help <name>` invocation. Known verb (including `help`
 * itself) prints that verb's detail page; unknown verb prints a
 * stderr line + the overview + exits 1; no argument prints the
 * overview + exits 0.
 *
 * Every table lookup goes through `Object.hasOwn` — a bare
 * `HELP_TEXTS[verb]` walks the prototype chain, so a verb named
 * `toString` / `constructor` / `hasOwnProperty` would yield a function
 * from `Object.prototype` and crash the writer when the result's
 * `stdout` is shoved at `process.stdout.write`.
 */
export function runHelpVerb(rest: readonly string[]): TmResult {
  const target = rest[0]
  if (target === undefined) return { code: 0, stdout: OVERVIEW_HELP, stderr: '' }
  if (target === 'help' || target === '-h' || target === '--help') {
    return { code: 0, stdout: OVERVIEW_HELP, stderr: '' }
  }
  if (Object.hasOwn(HELP_TEXTS, target)) {
    return { code: 0, stdout: HELP_TEXTS[target]!, stderr: '' }
  }
  return {
    code: 1,
    stdout: OVERVIEW_HELP,
    stderr: `tm: no help for unknown verb: ${target}\n`,
  }
}
