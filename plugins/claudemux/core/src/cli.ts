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
import { productionRegistry } from './engines/production'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { archiveVerb } from './verbs/archive'
import type { EngineContext } from './engines/types'
import {
  CompositeTeammateRouter,
  LegacyClaudeTmuxRouter,
  ProductionTeammateRouter,
} from './identity/router'
import { ProductionIdentityStore } from './persistence/identity-writer'
import type { VerbContext } from './verbs/context'
import { lsVerb } from './verbs/ls'
import { statesVerb } from './verbs/states'
import { statusVerb } from './verbs/status'
import { killVerb } from './verbs/kill'

/**
 * The Phase 2a-1 verb-side wiring. Decision 0024 §"Verb is the
 * abstraction" lets the verb layer fan out across engines through this
 * context; `cli.ts` builds one per invocation, hands the fleet-
 * visibility verbs the context, and lets the remaining 13 verbs keep
 * the legacy `NATIVE_VERBS` path until Phase 2a-2 moves their bodies
 * into `engines/claude/`.
 *
 * `ProductionTeammateRouter` reads `/tmp/teammate-<name>.json`; Phase
 * 2a-2 makes that the only path. While `tm spawn` still lives in
 * `native.ts` and does not write that JSON, `LegacyClaudeTmuxRouter`
 * runs a tmux session probe as a fallback so `tm status` / `tm kill`
 * keep finding existing teammates.
 */
function productionVerbContext(env: NativeEnv): VerbContext {
  const registry = env.engines ?? productionRegistry(env)

  const router = new CompositeTeammateRouter([
    new ProductionTeammateRouter(registry),
    new LegacyClaudeTmuxRouter(registry, async (session) => {
      try {
        return (await env.runTmux(['has-session', '-t', `=${session}`])).code === 0
      } catch {
        return false
      }
    }),
  ])

  const engineContext: EngineContext = { now: () => Date.now(), env: process.env }
  return {
    engines: registry,
    router,
    engineContext,
    identity: new ProductionIdentityStore(),
  }
}

/**
 * Verbs that route through the Engine layer in Phase 2a-1.
 *
 * Phase 2a-1 routed `ls` / `states` / `status` through the Engine layer.
 * Phase 2b registers `CodexEngine`, so `kill` can join the same path and
 * stop relying on the legacy `NATIVE_VERBS.kill` codex fork.
 */
const ENGINE_VERBS: ReadonlySet<string> = new Set(['ls', 'states', 'status', 'kill'])

/** Dispatch one of the fleet-visibility verbs through the verb context. */
async function dispatchEngineVerb(
  verb: string,
  rest: readonly string[],
  ctx: VerbContext,
): Promise<TmResult> {
  switch (verb) {
    case 'ls':
      return lsVerb(ctx)
    case 'states':
      return statesVerb(ctx)
    case 'status': {
      if (rest.length === 0) {
        return { code: 1, stdout: '', stderr: 'tm: usage: tm status <repo> [lines=80]\n' }
      }
      const lines = rest[1]
      const parsed = lines === undefined ? null : Number(lines)
      const linesArg = parsed === null || !Number.isFinite(parsed) ? null : parsed
      return statusVerb(rest[0]!, ctx, { lines: linesArg })
    }
    case 'kill':
      if (rest.length === 0) return { code: 1, stdout: '', stderr: 'tm: usage: tm kill <repo>\n' }
      return killVerb(rest[0]!, ctx)
    default:
      return { code: 1, stdout: '', stderr: `tm: unsupported engine verb: ${verb}\n` }
  }
}

/**
 * Whether `tm`'s help pre-scan would intercept these verb arguments. The
 * scan walks left to right: a `-h`/`--help` triggers help; a `--prompt` value
 * or the first non-flag positional stops it (help text must not swallow
 * prompt data that happens to contain `--help`). Mirrors the bash `main`
 * pre-scan that this layer replaces.
 *
 * Exported because `main.ts` needs it too: a verb that reads stdin (only
 * `archive`) must not slurp stdin when the invocation is going to print
 * help, since the help dispatch never reaches the reader and a pipe held
 * open by an upstream producer would block the launcher forever.
 */
export function triggersHelp(args: readonly string[]): boolean {
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
 *
 * Every table lookup goes through `Object.hasOwn` — a bare `HELP_TEXTS[verb]`
 * walks the prototype chain, so a verb named `toString` / `constructor` /
 * `hasOwnProperty` would yield a function from `Object.prototype` and crash
 * the writer when the result's `stdout` is shoved at `process.stdout.write`.
 */
function runHelpVerb(rest: readonly string[]): TmResult {
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
  // 1. Bare `tm` (or `tm ""`, mirroring bash `${1:-help}` which fires on
  //    both unset and null/empty) — fall through to the overview.
  if (verb === undefined || verb === '') {
    return { code: 0, stdout: OVERVIEW_HELP, stderr: '' }
  }

  // 2. The `help` / `-h` / `--help` verb forms.
  if (verb === 'help' || verb === '-h' || verb === '--help') {
    return runHelpVerb(rest)
  }

  // 3. Help pre-scan — `tm <verb> --help` (with any leading flags before the
  //    `--help`) prints that verb's detail. Unknown verb in this position
  //    falls through to the overview, matching bash's `declare -F help_<verb>`
  //    fallback to `cmd_help`.
  //
  //    Every dispatch-table lookup below uses `Object.hasOwn` so a verb name
  //    that collides with an Object.prototype key (`toString`, `constructor`,
  //    `hasOwnProperty`, `__proto__`) does not walk the prototype chain and
  //    return a function the writer then crashes on.
  if (triggersHelp(rest)) {
    const text = Object.hasOwn(HELP_TEXTS, verb) ? HELP_TEXTS[verb]! : OVERVIEW_HELP
    return { code: 0, stdout: text, stderr: '' }
  }

  // 4. Removed verbs — migration error on stderr, exit 2.
  if (Object.hasOwn(REMOVED_VERB_MESSAGES, verb)) {
    return removedVerb(REMOVED_VERB_MESSAGES[verb]!)
  }

  // 5a. Engine-routed verbs — fleet visibility and kill go through
  //     `verbs/<v>.ts` → `EngineRegistry` → concrete Engine methods.
  if (ENGINE_VERBS.has(verb)) {
    return dispatchEngineVerb(verb, rest, productionVerbContext(env))
  }

  // 5b. `archive` — a dispatcher-only verb (no engine). Phase 2a-1 moves
  //     its body into `verbs/archive.ts`; the legacy `NATIVE_VERBS.archive`
  //     stays in `native.ts` as a fallback the conformance harness still
  //     pins until Phase 2a-2.
  if (verb === 'archive') {
    return archiveVerb(rest, stdin, {
      dispatcherDir: env.dispatcherDir,
      projectsDir: env.projectsDir,
    })
  }

  // 5b. Native dispatch — the remaining 13 verbs still live in `native.ts`.
  //     Phase 2a-2 follow-up PR moves them into `engines/claude/`.
  if (Object.hasOwn(NATIVE_VERBS, verb)) {
    const handler = NATIVE_VERBS[verb]!
    const options: TmRunOptions | undefined = stdin != null ? { stdin } : undefined
    return handler(rest, options, env)
  }

  // 6. Unknown verb.
  return unknownVerb(verb)
}

/** The production `NativeEnv` — the real backends, resolved once per invocation. */
export function productionEnv(): NativeEnv {
  const env: NativeEnv = {
    runTmux,
    runColumn,
    runGrep,
    // `tm` resolves the dispatcher dir from `TM_DISPATCHER_DIR` or `$PWD`
    // (bash's `${TM_DISPATCHER_DIR:-$PWD}`). Two semantics matter here:
    //   - `$PWD` is the *logical* cwd, preserving the symlink the user
    //     `cd`'d through; Node's `process.cwd()` would return the
    //     symlink-resolved physical path, and `~/.claude/projects` lookups
    //     would diverge between bash and native on a symlinked dispatcher
    //     tree.
    //   - bash `${VAR:-default}` triggers the default on *unset* OR *empty*,
    //     so `||` (which treats empty strings as falsy) is the right
    //     operator — `??` would let an accidentally-empty
    //     `TM_DISPATCHER_DIR` through and resolve `<repo>` paths against
    //     `""`, while `tm doctor`'s own check treats empty as unset and
    //     reports the opposite of what the verbs saw.
    dispatcherDir: process.env.TM_DISPATCHER_DIR || process.env.PWD || process.cwd(),
    projectsDir: join(process.env.HOME ?? homedir(), '.claude', 'projects'),
  }
  return { ...env, engines: productionRegistry(env) }
}
