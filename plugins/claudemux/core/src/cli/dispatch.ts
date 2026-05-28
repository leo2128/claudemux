import { HELP_TEXTS, OVERVIEW_HELP, REMOVED_VERB_MESSAGES } from '../help'
import { pluginJsonPath, tmWrapperPath } from '../plugin-root'
import type { TmResult } from '../tm'
import type { NativeEnv } from '../env'
import type { Engine } from '../engines/engine'
import { archiveVerb } from '../verbs/archive'
import { askVerb } from '../verbs/ask'
import { pollVerb } from '../verbs/poll'
import type { VerbContext } from '../verbs/context'
import { lsVerb } from '../verbs/ls'
import { statesVerb } from '../verbs/states'
import { statusVerb } from '../verbs/status'
import { killVerb } from '../verbs/kill'
import { spawnVerb } from '../verbs/spawn'
import { sendVerb } from '../verbs/send'
import { waitVerb } from '../verbs/wait'
import { compactVerb } from '../verbs/compact'
import { resumeVerb } from '../verbs/resume'
import { lastVerb } from '../verbs/last'
import { ctxVerb } from '../verbs/ctx'
import { historyVerb } from '../verbs/history'
import { memVerb } from '../verbs/mem'
import { reloadVerb } from '../verbs/reload'
import { claudeDoctor } from '../engines/claude/doctor'
import {
  parseCompactArgs,
  parseResumeArgs,
  parseSendArgs,
  parseSpawnArgs,
  parseWaitArgs,
} from '../shared/verb-args'
import { formatContext, formatReload, noEngineRegistered } from '../verbs/format'
import { productionVerbContext } from './context'
import { die, removedVerb, runHelpVerb, unknownVerb } from './errors'
import {
  autoGenerateName,
  codexNameFailure,
  cwdForName,
  inferSpawnEngine,
  legacySchemaError,
  parseCtxArgs,
  parseReloadTargets,
  parseTimeoutMs,
  resolveRepoPath,
  resumeCwdProbeable,
  spawnCwdFor,
  triggersHelp,
} from './parse'
import {
  read as readIdentity,
  readArchived as readArchivedIdentity,
} from '../persistence/identity-store'
import { validateTeammateName } from '../identity/name'

interface FleetTarget {
  readonly name: string
  readonly engine: Engine
}

async function fleetTargets(ctx: VerbContext): Promise<TmResult | FleetTarget[]> {
  const engines = ctx.engines.registered()
  if (engines.length === 0) return noEngineRegistered()
  const listings = (await Promise.all(
    engines.map(async (engine) => ({
      engine,
      rows: await engine.list(ctx.engineContext),
    })),
  )).flatMap(({ engine, rows }) => rows.map((row) => ({ name: row.name, engine })))
  const seen = new Set<string>()
  const targets: FleetTarget[] = []
  for (const target of listings) {
    if (seen.has(target.name)) continue
    seen.add(target.name)
    targets.push(target)
  }
  return targets
}

async function combineResults(results: readonly Promise<TmResult>[]): Promise<TmResult> {
  let code = 0
  let stdout = ''
  let stderr = ''
  for (const result of await Promise.all(results)) {
    if (code === 0 && result.code !== 0) code = result.code
    stdout += result.stdout
    stderr += result.stderr
  }
  return { code, stdout, stderr }
}

// ─── Engine-routed teammate verbs ─────────────────────────────────────────

const ENGINE_VERBS: ReadonlySet<string> = new Set([
  'ls',
  'states',
  'status',
  'kill',
  'spawn',
  'send',
  'wait',
  'compact',
  'resume',
  'last',
  'ctx',
  'history',
  'mem',
  'reload',
])

async function dispatchEngineVerb(
  verb: string,
  rest: readonly string[],
  ctx: VerbContext,
  env: NativeEnv,
): Promise<TmResult> {
  switch (verb) {
    case 'ls':
      return lsVerb(ctx)
    case 'states':
      return statesVerb(ctx)
    case 'status': {
      if (rest.length === 0) {
        return { code: 1, stdout: '', stderr: 'tm: usage: tm status <name> [lines=80]\n' }
      }
      const legacy = legacySchemaError(rest[0]!, 'status')
      if (legacy !== null) return legacy
      const lines = rest[1]
      const parsed = lines === undefined ? null : Number(lines)
      const linesArg = parsed === null || !Number.isFinite(parsed) ? null : parsed
      return statusVerb(rest[0]!, ctx, { lines: linesArg })
    }
    case 'kill': {
      if (rest.length === 0) return { code: 1, stdout: '', stderr: 'tm: usage: tm kill <name>\n' }
      // No `legacySchemaError` guard here on purpose: the migration
      // message for a schema=1 record is literally "run `tm kill`",
      // so this verb must be reachable on a legacy record. The
      // claude engine's `kill()` cleans tmux + the bash-side marker
      // files unconditionally, and `ctx.identity.remove(name)`
      // sweeps the JSON regardless of its on-disk schema version.
      return killVerb(rest[0]!, ctx)
    }
    case 'spawn': {
      const rawPath = rest[0] ?? ''
      if (rawPath.length === 0) {
        return die('usage: tm spawn <path> [--name <id>] [--prompt "..."] [--no-worktree]')
      }
      const parsed = parseSpawnArgs(rest.slice(1))
      if ('error' in parsed) return parsed.error
      const timeoutMs = parseTimeoutMs('tm spawn', parsed.timeout)
      if (timeoutMs !== null && typeof timeoutMs === 'object') return timeoutMs.error
      const repoResolved = resolveRepoPath(rawPath, env)
      if ('error' in repoResolved) return repoResolved.error
      const repo = repoResolved.repo
      const name = parsed.name.length > 0 ? parsed.name : autoGenerateName(repo)
      const validation = validateTeammateName(name)
      if (validation.kind !== 'ok') {
        return die(`tm spawn: invalid name '${name}': ${validation.reason}`)
      }
      const engine = await inferSpawnEngine(parsed.engine)
      if (engine === 'codex') {
        const invalidName = codexNameFailure(name)
        if (invalidName !== null) return die(invalidName)
      }
      const worktreeSlug = parsed.noWorktree ? null : name
      const cwd = spawnCwdFor(repo, worktreeSlug)
      return spawnVerb(
        {
          name,
          engine,
          repo,
          cwd,
          worktreeSlug,
          resumeCheckpoint: parsed.resumeSid.length === 0 ? null : parsed.resumeSid,
          prompt: parsed.hasPrompt ? parsed.prompt : null,
          timeoutMs,
          displayName: null,
        },
        ctx,
      )
    }
    case 'send': {
      const parsed = parseSendArgs(rest)
      if ('error' in parsed) return parsed.error
      if (parsed.name === '') {
        return die(
          'tm send: missing <name>. Usage: tm send <name> --prompt "..." ' +
            '[--pane-quiet] [--timeout N]',
        )
      }
      if (!parsed.hasPrompt) {
        return die(
          'tm send: missing --prompt. Usage: tm send <name> --prompt "..." ' +
            '[--pane-quiet] [--timeout N]',
        )
      }
      const legacy = legacySchemaError(parsed.name, 'send')
      if (legacy !== null) return legacy
      const timeoutMs = parseTimeoutMs('tm send', parsed.timeout)
      if (timeoutMs !== null && typeof timeoutMs === 'object') return timeoutMs.error
      return sendVerb(
        {
          name: parsed.name,
          prompt: parsed.prompt,
          timeoutMs,
          paneQuiet: parsed.paneQuiet,
        },
        ctx,
      )
    }
    case 'wait': {
      const parsed = parseWaitArgs(rest)
      if ('error' in parsed) return parsed.error
      if (parsed.name === '') {
        return die('usage: tm wait <name> [timeout=1800] [--fresh] [--pane-quiet] [--timeout N]')
      }
      const legacy = legacySchemaError(parsed.name, 'wait')
      if (legacy !== null) return legacy
      const timeoutMs = parseTimeoutMs('tm wait', parsed.timeout)
      if (timeoutMs !== null && typeof timeoutMs === 'object') return timeoutMs.error
      return waitVerb(
        {
          name: parsed.name,
          recoverFor: null,
          timeoutMs,
          fresh: parsed.fresh,
          paneQuiet: parsed.paneQuiet,
        },
        ctx,
      )
    }
    case 'compact': {
      const parsed = parseCompactArgs(rest)
      if ('error' in parsed) return parsed.error
      const legacy = legacySchemaError(parsed.name, 'compact')
      if (legacy !== null) return legacy
      const timeoutMs = parseTimeoutMs('tm compact', parsed.timeout)
      if (timeoutMs !== null && typeof timeoutMs === 'object') return timeoutMs.error
      return compactVerb(parsed.name, ctx, { timeoutMs })
    }
    case 'resume': {
      const parsed = parseResumeArgs(rest)
      if ('error' in parsed) return parsed.error
      if (parsed.name === '') {
        return die(
          'usage: tm resume <name> [<sid-or-thread-id>] [--prompt "..."] ' +
            '[--engine claude|codex]  (id may be omitted: claudemux probes both engines ' +
            'for a resumable session and routes the single candidate; if both engines have ' +
            'history, use --engine to disambiguate)',
        )
      }
      const legacy = legacySchemaError(parsed.name, 'resume')
      if (legacy !== null) return legacy
      // After a clean kill the live identity is gone, but the archive
      // snapshot — written by `tm kill` before the live record was
      // deleted — still carries the launch context (repo /
      // worktreeSlug / displayName). Fall back to it so the resume
      // verb has the same `repo` / `worktreeSlug` it would have had
      // pre-kill; without that, `tm resume <name> <sid>` after a
      // clean kill cannot re-provision the worktree.
      const liveIdentity = readIdentity(parsed.name)
      const recordSource = liveIdentity ?? readArchivedIdentity(parsed.name)
      return resumeVerb(
        {
          name: parsed.name,
          repo: recordSource?.repo ?? null,
          cwd: cwdForName(parsed.name, env),
          worktreeSlug: recordSource?.worktreeSlug ?? null,
          checkpoint: parsed.sid.length === 0 ? null : parsed.sid,
          prompt: parsed.hasPrompt ? parsed.prompt : null,
          displayName: recordSource?.displayName ?? null,
          engineHint: parsed.engine,
          projectsDir: env.projectsDir,
          cwdProbeable: resumeCwdProbeable(parsed.name, env),
        },
        ctx,
      )
    }
    case 'last': {
      let name = ''
      let verbose = false
      for (const arg of rest) {
        if (arg === '--verbose') {
          verbose = true
        } else if (arg.startsWith('--')) {
          return die(`tm last: unknown option ${arg}`)
        } else if (name.length === 0) {
          name = arg
        } else {
          return die('usage: tm last <name> [--verbose]')
        }
      }
      if (name.length === 0) return die('usage: tm last <name> [--verbose]')
      const legacy = legacySchemaError(name, 'last')
      if (legacy !== null) return legacy
      return lastVerb(name, ctx, { verbose })
    }
    case 'ctx': {
      const parsed = parseCtxArgs(rest)
      if ('error' in parsed) return parsed.error
      const results = parsed.repos.map((name) =>
        ctxVerb(name, ctx, { windowOverride: parsed.windowOverride }),
      )
      if (parsed.all) {
        const targets = await fleetTargets(ctx)
        if (!Array.isArray(targets)) return targets
        results.push(
          ...targets.map(async (target) =>
            formatContext(
              await target.engine.ctx(
                { name: target.name, windowOverride: parsed.windowOverride },
                ctx.engineContext,
              ),
            ),
          ),
        )
      }
      if (results.length === 0) {
        return die('usage: tm ctx <name> [<name>...] | --all  [--window 200k|1m]')
      }
      return combineResults(results)
    }
    case 'history': {
      const name = rest[0] ?? ''
      if (name.length === 0) return die('usage: tm history <name> [<sid-or-thread-prefix>]')
      const legacy = legacySchemaError(name, 'history')
      if (legacy !== null) return legacy
      return historyVerb({ name, cwd: cwdForName(name, env), index: rest[1] ?? null }, ctx)
    }
    case 'mem': {
      const name = rest[0] ?? ''
      if (name.length === 0) return die('usage: tm mem <name>')
      const legacy = legacySchemaError(name, 'mem')
      if (legacy !== null) return legacy
      return memVerb(name, ctx)
    }
    case 'reload': {
      const parsed = parseReloadTargets(rest)
      if ('error' in parsed) return parsed.error
      let stdout = ''
      let stderr = ''
      if (parsed.all) {
        const targets = await fleetTargets(ctx)
        if (!Array.isArray(targets)) return targets
        if (targets.length === 0) {
          return { code: 0, stdout: '(no teammate sessions to reload)\n', stderr: '' }
        }
        for (const target of targets) {
          const result = formatReload(
            await target.engine.reload({ name: target.name }, ctx.engineContext),
          )
          stdout += result.stdout
          stderr += result.stderr
          if (result.code !== 0) return { code: result.code, stdout, stderr }
        }
      } else {
        for (const target of parsed.repos) {
          const result = await reloadVerb(target, ctx)
          stdout += result.stdout
          stderr += result.stderr
          if (result.code !== 0) return { code: result.code, stdout, stderr }
        }
      }
      return { code: 0, stdout, stderr }
    }
    default:
      return { code: 1, stdout: '', stderr: `tm: unsupported engine verb: ${verb}\n` }
  }
}

async function doctorDispatch(args: readonly string[], env: NativeEnv): Promise<TmResult> {
  return claudeDoctor(args, env, {
    tmWrapper: tmWrapperPath(),
    pluginJson: pluginJsonPath(),
  })
}

/**
 * Dispatch one CLI invocation. `argv` is the argument vector after the
 * program name (`process.argv.slice(2)`).
 *
 * Routing order:
 *   1. Bare `tm`                    → overview, exit 0
 *   2. `tm help [<verb>]`           → per-verb or overview, exit 0/1
 *   3. Help pre-scan on `rest`      → per-verb (if HELP_TEXTS) or overview, exit 0
 *   4. Removed verb                 → migration message, exit 2
 *   5. Engine-routed teammate verbs → verbs/<v>.ts → router/registry → engine
 *   6. Dispatcher-only / diagnostic  → local verb
 *   7. Unknown verb                  → stderr + overview, exit 1
 */
export async function runCli(
  argv: readonly string[],
  env: NativeEnv,
  stdin?: string,
): Promise<TmResult> {
  const [verb, ...rest] = argv
  // 1. Bare `tm` (or `tm ""`, mirroring bash `${1:-help}` which fires
  //    on both unset and null/empty) — fall through to the overview.
  if (verb === undefined || verb === '') {
    return { code: 0, stdout: OVERVIEW_HELP, stderr: '' }
  }

  // 2. The `help` / `-h` / `--help` verb forms.
  if (verb === 'help' || verb === '-h' || verb === '--help') {
    return runHelpVerb(rest)
  }

  // 3. Help pre-scan — `tm <verb> --help` prints that verb's detail.
  //    Every dispatch-table lookup below uses `Object.hasOwn` so a verb
  //    name that collides with an Object.prototype key does not walk
  //    the prototype chain.
  if (triggersHelp(rest)) {
    const text = Object.hasOwn(HELP_TEXTS, verb) ? HELP_TEXTS[verb]! : OVERVIEW_HELP
    return { code: 0, stdout: text, stderr: '' }
  }

  // 4. Removed verbs — migration error on stderr, exit 2.
  if (Object.hasOwn(REMOVED_VERB_MESSAGES, verb)) {
    return removedVerb(REMOVED_VERB_MESSAGES[verb]!)
  }

  // 5. Engine-routed teammate verbs — parse at the CLI boundary, then
  //    `verbs/<v>.ts` → `EngineRegistry` / router → concrete Engine methods.
  if (ENGINE_VERBS.has(verb)) {
    return dispatchEngineVerb(verb, rest, productionVerbContext(env), env)
  }

  // 6. Dispatcher-only / diagnostic verbs.
  switch (verb) {
    case 'archive':
      return archiveVerb(rest, stdin, {
        dispatcherDir: env.dispatcherDir,
        projectsDir: env.projectsDir,
      })
    case 'doctor':
      return doctorDispatch(rest, env)
    case 'poll':
      return pollVerb(rest, env)
    case 'ask':
      return askVerb(rest)
    default:
      // 7. Unknown verb.
      return unknownVerb(verb)
  }
}
