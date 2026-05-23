/**
 * The CLI front end — `tm <verb> [args...]`, as a library.
 *
 * `tm` is invoked once per command and exits; the dispatcher reads its
 * stdout, stderr, and exit code. This module is the per-invocation router:
 * parse the argument vector, route to the right handler — native verb, help
 * print, removed-verb error, or unknown-verb error — and produce a
 * `TmResult`. No state is held between invocations: it lives in tmux, the
 * `/tmp` protocol files, and the Claude Code projects directory.
 *
 * On the `next` line the Bash `bin/tm` is retired, so every routing decision
 * that used to live in `bin/tm`'s `main` lives here — the help pre-scan, the
 * `help <verb>` form, the removed-verb migration messages, and the
 * unknown-verb error. The help text itself lives in [`help.ts`](./help.ts).
 *
 * The process entrypoint that wires `process.argv` / `process.stdin` /
 * `process.exitCode` to `runCli` is [`main.ts`](./main.ts); this module
 * exports `runCli` and `productionEnv` so a test or harness can drive a
 * single invocation in-process with controlled inputs.
 */

import { runColumn } from './column'
import { runGrep } from './grep'
import { HELP_TEXTS, OVERVIEW_HELP, REMOVED_VERB_MESSAGES } from './help'
import { NATIVE_VERBS, type NativeEnv } from './native'
import { type TmResult, type TmRunOptions } from './tm'
import { runTmux } from './tmux'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Whether `tm`'s help pre-scan would intercept these verb arguments. The
 * scan walks left to right: a `-h`/`--help` triggers help; a `--prompt` value
 * or the first non-flag positional stops it (help text must not swallow
 * prompt data that happens to contain `--help`). Mirrors the bash `main`
 * pre-scan that this layer replaces.
 */
function triggersHelp(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') return true
    if (arg === '--prompt' || arg.startsWith('--prompt=')) return false
    if (!arg.startsWith('-')) return false
  }
  return false
}

/** A removed verb's migration message + exit 2 — bash `main`'s `ask)` / `wait-idle)` / `wait-quiet)` arms. */
function removedVerb(message: string): TmResult {
  return { code: 2, stdout: '', stderr: message }
}

/** The unknown-subcommand error: stderr line + overview on stdout + exit 1. */
function unknownVerb(verb: string): TmResult {
  return {
    code: 1,
    stdout: OVERVIEW_HELP,
    stderr: `tm: unknown subcommand: ${verb}\n`,
  }
}

/**
 * Route a `tm help <name>` invocation. Mirrors bash `main`'s `help|-h|--help`
 * arm: known verb (including `help` itself, since bash's `help_help` calls
 * `cmd_help`) prints that verb's detail page; unknown verb prints a stderr
 * line + the overview + exits 1; no argument prints the overview + exits 0.
 */
function runHelpVerb(rest: readonly string[]): TmResult {
  const target = rest[0]
  if (target === undefined) return { code: 0, stdout: OVERVIEW_HELP, stderr: '' }
  if (target === 'help' || target === '-h' || target === '--help') {
    return { code: 0, stdout: OVERVIEW_HELP, stderr: '' }
  }
  const text = HELP_TEXTS[target]
  if (text !== undefined) return { code: 0, stdout: text, stderr: '' }
  return {
    code: 1,
    stdout: OVERVIEW_HELP,
    stderr: `tm: no help for unknown verb: ${target}\n`,
  }
}

/**
 * Dispatch one CLI invocation. `argv` is the argument vector after the
 * program name (`process.argv.slice(2)`).
 *
 * Routing order — matches bash `main`:
 *   1. Bare `tm`                    → overview, exit 0
 *   2. `tm help [<verb>]`           → per-verb or overview, exit 0/1
 *   3. Help pre-scan on `rest`      → per-verb (if HELP_TEXTS) or overview, exit 0
 *   4. Removed verb                 → migration message, exit 2
 *   5. Native verb                  → dispatch
 *   6. Unknown verb                 → stderr + overview, exit 1
 */
export async function runCli(
  argv: readonly string[],
  env: NativeEnv,
  stdin?: string,
): Promise<TmResult> {
  const [verb, ...rest] = argv
  // 1. Bare `tm` — bash sets `sub="${1:-help}"`, falls into the help case.
  if (verb === undefined) return { code: 0, stdout: OVERVIEW_HELP, stderr: '' }

  // 2. The `help` / `-h` / `--help` verb forms.
  if (verb === 'help' || verb === '-h' || verb === '--help') {
    return runHelpVerb(rest)
  }

  // 3. Help pre-scan — `tm <verb> --help` (with any leading flags before the
  //    `--help`) prints that verb's detail. Unknown verb in this position
  //    falls through to the overview, matching bash's `declare -F help_<verb>`
  //    fallback to `cmd_help`.
  if (triggersHelp(rest)) {
    const text = HELP_TEXTS[verb]
    return { code: 0, stdout: text ?? OVERVIEW_HELP, stderr: '' }
  }

  // 4. Removed verbs — migration error on stderr, exit 2.
  const removedMessage = REMOVED_VERB_MESSAGES[verb]
  if (removedMessage !== undefined) return removedVerb(removedMessage)

  // 5. Native dispatch. After 3c every verb is in `NATIVE_VERBS`.
  const handler = NATIVE_VERBS[verb]
  if (handler !== undefined) {
    const options: TmRunOptions | undefined = stdin != null ? { stdin } : undefined
    return handler(rest, options, env)
  }

  // 6. Unknown verb.
  return unknownVerb(verb)
}

/** The production `NativeEnv` — the real backends, resolved once per invocation. */
export function productionEnv(): NativeEnv {
  return {
    runTmux,
    runColumn,
    runGrep,
    // `tm` resolves the dispatcher dir from `TM_DISPATCHER_DIR` or `$PWD`
    // (bash's `${TM_DISPATCHER_DIR:-$PWD}`). `$PWD` is the *logical* cwd —
    // it preserves the symlink the user `cd`'d through, where Node's
    // `process.cwd()` would return the symlink-resolved physical path; the
    // two differ on a symlinked dispatcher tree and `~/.claude/projects`
    // lookups would diverge between bash and native. Match bash by
    // preferring `$PWD`.
    dispatcherDir: process.env.TM_DISPATCHER_DIR ?? process.env.PWD ?? process.cwd(),
    projectsDir: join(process.env.HOME ?? homedir(), '.claude', 'projects'),
  }
}
