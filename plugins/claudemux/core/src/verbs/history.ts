/**
 * `tm history <name> [index]` — turn-by-turn history. Decision multi-engine-tui-architecture
 * §"`history` and `mem` stay" keeps the verb alive on both engines.
 * The Claude engine reads `~/.claude/projects/<encoded>/*.jsonl`;
 * the Codex engine reads rollout JSONL files from `~/.codex/sessions`.
 * List mode merges both engines by mtime; detail mode accepts either a
 * Claude sid prefix or a Codex thread-id prefix.
 */

import { formatHistory } from './format'
import type { Engine } from '../engines/engine'
import type {
  EngineKind,
  HistoryListEntry,
  HistoryRequest,
  HistoryResult,
  TeammateName,
} from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'
import { resolveTargetEngine } from './resolve'
import { hasCodexHistoryForCwd } from '../engines/codex/history'
import { fmtAge } from '../engines/claude/clock'

export interface HistoryArgs {
  readonly name: TeammateName
  readonly cwd: string | null
  /** `null` = list view; non-null = engine-specific detail selector. */
  readonly index: string | null
}

interface HistoryTarget {
  readonly engine: Engine
  readonly resolved: boolean
  readonly codexFromHistory: boolean
}

async function resolveHistoryTarget(args: HistoryArgs, ctx: VerbContext): Promise<HistoryTarget | TmResult> {
  const resolved = await ctx.router.resolve(args.name)
  const codexFromHistory =
    resolved === null &&
    args.cwd !== null &&
    ctx.engines.get('codex') !== undefined &&
    hasCodexHistoryForCwd(args.cwd, ctx.engineContext.env)
  const engine = codexFromHistory
    ? ctx.engines.get('codex')!
    : resolved?.engine ?? await resolveTargetEngine(args.name, ctx)
  if ('code' in engine) return engine
  return { engine, resolved: resolved !== null, codexFromHistory }
}

function historyCandidateEngines(target: HistoryTarget, ctx: VerbContext): readonly Engine[] {
  const engines: Engine[] = []
  const add = (engine: Engine | undefined): void => {
    if (engine === undefined) return
    if (!engines.some((candidate) => candidate.kind === engine.kind)) engines.push(engine)
  }

  if (target.engine.kind === 'codex' && !target.codexFromHistory && !target.resolved) {
    add(target.engine)
    return engines
  }

  add(ctx.engines.get('claude'))
  add(ctx.engines.get('codex'))
  add(target.engine)
  return engines
}

/**
 * Detail-mode prefix → engine, when the UUID version digit is reachable
 * inside the prefix. Claude sids are random UUIDv4 (`xxxxxxxx-xxxx-4xxx-...`);
 * Codex thread ids are UUIDv7 (`xxxxxxxx-xxxx-7xxx-...`). Stripping `-` and
 * inspecting the 13th hex char (index 12) gives the version regardless of
 * whether the caller pasted the canonical dashed form or a raw hex run.
 * Returns `null` when the prefix is too short to reach the version digit,
 * or when the version digit is neither `4` nor `7` — both cases fall back
 * to the existing dual-engine probe rather than silently misroute.
 */
function detailEngineFromPrefix(prefix: string): EngineKind | null {
  const stripped = prefix.replace(/-/g, '')
  if (stripped.length < 13) return null
  const versionChar = stripped[12]
  if (versionChar === '4') return 'claude'
  if (versionChar === '7') return 'codex'
  return null
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1048576) return `${Math.trunc(bytes / 1024)}K`
  if (bytes < 1073741824) return `${toFixed1HalfEven(bytes / 1048576)}M`
  return `${toFixed1HalfEven(bytes / 1073741824)}G`
}

function toFixed1HalfEven(value: number): string {
  const tenths = value * 10
  const floor = Math.floor(tenths)
  const frac = tenths - floor
  let rounded: number
  if (frac < 0.5) rounded = floor
  else if (frac > 0.5) rounded = floor + 1
  else rounded = floor % 2 === 0 ? floor : floor + 1
  return (rounded / 10).toFixed(1)
}

function sortedHistoryEntries(entries: readonly HistoryListEntry[]): readonly HistoryListEntry[] {
  return [...entries].sort((a, b) =>
    b.mtimeMs - a.mtimeMs ||
    (a.engine < b.engine ? -1 : a.engine > b.engine ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
}

async function formatHistoryEntries(
  entries: readonly HistoryListEntry[],
  ctx: VerbContext,
): Promise<TmResult> {
  const nowMs = ctx.engineContext.now()
  const rows: string[][] = [[' ', 'ENGINE', 'ID', 'AGE', 'SIZE', 'TOPIC']]
  // Full id, not an 8-char prefix: `tm resume` requires the canonical UUID
  // and silently rejects a prefix with a misleading "wrong repo" error.
  // Listing the full id keeps history → resume copy-paste lossless.
  for (const entry of sortedHistoryEntries(entries)) {
    rows.push([
      entry.active ? '*' : ' ',
      entry.engine,
      entry.id,
      fmtAge(Math.max(0, Math.floor((nowMs - entry.mtimeMs) / 1000))),
      fmtSize(entry.size),
      entry.topic,
    ])
  }
  return ctx.runColumn(`${rows.map((row) => row.join('\t')).join('\n')}\n`)
}

function raw(result: HistoryResult): TmResult {
  return formatHistory(result)
}

export async function historyVerb(args: HistoryArgs, ctx: VerbContext): Promise<TmResult> {
  const target = await resolveHistoryTarget(args, ctx)
  if ('code' in target) return target
  const req: HistoryRequest = { name: args.name, cwd: args.cwd, index: args.index }

  if (args.index !== null) {
    // UUID-version short-circuit: when the prefix is long enough to expose
    // the version digit (claude=v4, codex=v7), route to that one engine and
    // skip the cross-engine probe. The other engine cannot hold a session
    // whose id begins with the wrong version digit, so probing it would only
    // walk a rollout tree that is guaranteed to miss.
    const shortCircuit = detailEngineFromPrefix(args.index)
    const shortCircuitEngine = shortCircuit !== null ? ctx.engines.get(shortCircuit) : undefined
    if (shortCircuitEngine !== undefined) {
      return raw(await shortCircuitEngine.history(req, ctx.engineContext))
    }

    const engines = historyCandidateEngines(target, ctx)
    const results = await Promise.all(
      engines.map(async (engine) => ({ engine, result: await engine.history(req, ctx.engineContext) })),
    )
    const successes = results
      .map(({ result }) => raw(result))
      .filter((result) => result.code === 0)
    if (successes.length === 1) return successes[0]!
    if (successes.length > 1) {
      return {
        code: 1,
        stdout: '',
        stderr: `tm: history: prefix '${args.index}' matches entries in multiple engines - be more specific\n`,
      }
    }
    const targetResult = results.find(({ engine }) => engine.kind === target.engine.kind)?.result ??
      await target.engine.history(req, ctx.engineContext)
    return raw(targetResult)
  }

  const engines = historyCandidateEngines(target, ctx)
  const results = await Promise.all(
    engines.map(async (engine) => ({ engine, result: await engine.history(req, ctx.engineContext) })),
  )
  const entries = results.flatMap(({ result }) =>
    result.kind === 'list' && result.entries !== undefined ? [...result.entries] : [],
  )
  if (entries.length > 0) return formatHistoryEntries(entries, ctx)

  const targetResult = results.find(({ engine }) => engine.kind === target.engine.kind)?.result ??
    await target.engine.history(req, ctx.engineContext)
  return raw(targetResult)
}
