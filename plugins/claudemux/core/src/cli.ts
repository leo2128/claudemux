/**
 * The CLI front end — `tm <verb> [args...]`.
 *
 * `tm` is invoked once per command and exits; the dispatcher reads its
 * stdout, stderr, and exit code. This module is that per-invocation entry:
 * parse the argument vector, run the verb (native code or a `tm` shell-out,
 * via `runVerb`), write the verb's streams to the process streams, and exit
 * with the verb's code. No state is held between invocations — it lives in
 * tmux, the `/tmp` protocol files, and the Claude Code projects directory.
 */

import { runColumn } from './column'
import { runVerb } from './core'
import { runGrep } from './grep'
import type { NativeEnv } from './native'
import { type RawTmRunner, type TmResult, runTm, runTmRaw } from './tm'
import { runTmux } from './tmux'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Backends the CLI front end runs a verb against. */
export interface CliDeps extends NativeEnv {
  /** Shells a raw argument vector out to `tm` — for a bare `tm` invocation. */
  runTmRaw: RawTmRunner
}

/**
 * Dispatch one CLI invocation. `argv` is the argument vector after the program
 * name (`process.argv.slice(2)`). A verb invocation runs through `runVerb`,
 * which decides native-vs-shell-out; a bare `tm` shells out to `tm` itself,
 * which owns the no-verb help screen.
 */
export async function runCli(
  argv: string[],
  deps: CliDeps,
  stdin?: string,
): Promise<TmResult> {
  const options = stdin != null ? { stdin } : undefined
  const [verb, ...rest] = argv
  if (verb === undefined) return deps.runTmRaw([], options)
  return runVerb(verb, rest, options, deps)
}

/**
 * Read all of stdin. Returns `undefined` when stdin is an interactive TTY, so
 * an interactive invocation never blocks waiting for an EOF that will not come.
 */
async function readStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** The production `CliDeps` — the real backends, resolved once per invocation. */
function productionDeps(): CliDeps {
  return {
    runTm,
    runTmRaw,
    runTmux,
    runColumn,
    runGrep,
    // `tm` resolves the dispatcher dir from `TM_DISPATCHER_DIR` or the cwd;
    // the projects dir mirrors `tm`'s use of `$HOME` for `~/.claude/projects`.
    dispatcherDir: process.env.TM_DISPATCHER_DIR ?? process.cwd(),
    projectsDir: join(process.env.HOME ?? homedir(), '.claude', 'projects'),
  }
}

/** Process entry: dispatch, write the verb's streams, exit with its code. */
async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  // `archive` is the only verb that reads stdin; reading it for any other verb
  // risks blocking on a pipe that is open but never written.
  const stdin = argv[0] === 'archive' ? await readStdin() : undefined
  const result = await runCli(argv, productionDeps(), stdin)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  process.exitCode = result.code
}

// Run `main` when invoked as a script, not when imported (a test imports
// `runCli`). `realpathSync` canonicalizes the invocation path so a symlinked
// launcher still matches the symlink-resolved module path.
const invokedPath = process.argv[1]
if (invokedPath !== undefined && realpathSync(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[tm] ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
}
