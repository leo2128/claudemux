import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'

import { isNonNegativeInteger } from '../engines/claude/clock'
import { randSuffix } from '../engines/claude/identifiers'
import { readBaseRecord, readCodexMeta } from '../engines/codex/persistence'
import { worktreePathFor } from '../persistence/paths'
import {
  read as readIdentity,
  readArchived as readArchivedIdentity,
  readRawSchema,
} from '../persistence/identity-store'
import type { EngineKind } from '../engines/types'
import type { NativeEnv } from '../env'
import { validateTeammateName } from '../identity/name'
import type { TmResult } from '../tm'
import { die } from './errors'

/**
 * Whether `tm`'s help pre-scan would intercept these verb arguments.
 * The scan walks left to right: a `-h`/`--help` triggers help; a
 * `--prompt` value or the first non-flag positional stops it (help
 * text must not swallow prompt data that happens to contain `--help`).
 *
 * Exported because `main.ts` needs it too: a verb that reads stdin
 * (only `archive`) must not slurp stdin when the invocation is going
 * to print help, since the help dispatch never reaches the reader and
 * a pipe held open by an upstream producer would block the launcher
 * forever.
 */
export function triggersHelp(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === '-h' || arg === '--help') return true
    if (arg === '--prompt' || arg.startsWith('--prompt=')) return false
    if (!arg.startsWith('-')) return false
  }
  return false
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function secondsToMs(value: string | null): number | null {
  return value === null ? null : Number(value) * 1000
}

export function parseTimeoutMs(
  label: string,
  value: string | null,
): number | null | { error: TmResult } {
  if (value === null) return null
  if (!isNonNegativeInteger(value)) {
    return { error: die(`${label}: --timeout must be a non-negative integer (got: '${value}')`) }
  }
  return secondsToMs(value)
}

export function codexNameFailure(name: string): string | null {
  const validation = validateTeammateName(name)
  return validation.kind === 'ok'
    ? null
    : `invalid codex teammate name '${name}': ${validation.reason}`
}

export async function inferSpawnEngine(
  requested: EngineKind | null,
): Promise<EngineKind> {
  if (requested !== null) return requested
  // Schema-2 default: no name-based pre-routing — Claude unless --engine codex.
  // (Resume probes engines explicitly via verbs/resume.ts.)
  return 'claude'
}

/**
 * Resolve a CLI `<path>` positional into an absolute repo path. An
 * absolute path is taken as-is; a relative path is resolved against
 * the dispatcher dir. `realpathSync` collapses symlinks so the
 * recorded `repo` matches what the SessionStart hook will report.
 */
export function resolveRepoPath(
  rawPath: string,
  env: NativeEnv,
): { repo: string } | { error: TmResult } {
  if (rawPath.length === 0) {
    return { error: die('tm spawn: <path> is required') }
  }
  const absolute = isAbsolute(rawPath) ? rawPath : resolve(env.dispatcherDir, rawPath)
  if (!existsSync(absolute)) {
    return {
      error: die(
        `tm spawn: <path> '${rawPath}' does not exist (resolved to ${absolute})`,
      ),
    }
  }
  if (!isDirectory(absolute)) {
    return {
      error: die(`tm spawn: <path> '${rawPath}' is not a directory (resolved to ${absolute})`),
    }
  }
  return { repo: realpathSync(absolute) }
}

/**
 * Generate a default teammate name from a resolved repo path. The
 * shape is `<leaf>-<rand4>`, where `<leaf>` is `path.basename(repo)`
 * sanitized to ASCII alnum + `-` / `_`. The trailing `-<rand4>`
 * ensures a fresh spawn never collides with a prior teammate of the
 * same leaf even when the user does not pass `--name`.
 */
export function autoGenerateName(repo: string): string {
  const raw = basename(repo)
  // Drop anything outside the flat-name charset; collapse runs of `-`.
  let leaf = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (leaf.length === 0) leaf = 'tm'
  // Make sure the result starts with an alnum — the validator rejects
  // leading `-` / `_`. A sanitized leaf may start with `-` if the
  // basename was `_foo` or `-foo`; trim until alnum.
  while (leaf.length > 0 && !/^[A-Za-z0-9]/.test(leaf)) leaf = leaf.slice(1)
  if (leaf.length === 0) leaf = 'tm'
  return `${leaf}-${randSuffix()}`
}

/**
 * The runtime cwd for a spawn. Worktree mode places the teammate in
 * `<repo>/.claude/worktrees/<slug>`; `--no-worktree` keeps it at the
 * repo root.
 */
export function spawnCwdFor(
  repo: string,
  worktreeSlug: string | null,
): string {
  return worktreeSlug === null ? repo : worktreePathFor(repo, worktreeSlug)
}

/**
 * Detect a stale schema=1 identity record. Returns a `TmResult`
 * error that the spawn / send / wait / kill / etc dispatchers can
 * surface verbatim so the user sees a clear "kill and respawn"
 * migration hint instead of a silent not-found.
 */
export function legacySchemaError(name: string, verb: string): TmResult | null {
  const schema = readRawSchema(name)
  if (schema === null) return null
  if (schema === 2) return null
  return die(
    `tm ${verb}: teammate '${name}' has a legacy schema=${schema} identity ` +
      "record (pre name/repo decoupling). Kill and respawn: " +
      `'tm kill ${name}' then 'tm spawn <path> --name ${name}'.`,
  )
}

function normalizeExistingCwd(cwd: string): string {
  try {
    return realpathSync(cwd)
  } catch {
    return cwd
  }
}

/**
 * Resolve the runtime cwd for a verb that targets an existing
 * teammate by name. Reads, in order:
 *
 *  1. the live identity record (running or just-spawned teammate);
 *  2. the archived identity record written at `tm kill` time — so a
 *     post-kill `tm resume <name> <sid>` or `tm history <name>` lands
 *     on the worktree-encoded project-dir slug rather than the
 *     dispatcher's slug;
 *  3. the Codex registry's cwd hint (Codex daemon meta + base record);
 *  4. a `<dispatcherDir>/<name>` probe — the shape `tm resume`
 *     accepts when the source directory lives under the dispatcher;
 *  5. the dispatcher dir itself, as the last-resort fallback.
 *
 * The fallback is **never** `process.cwd()`: a `tm` invocation that
 * lands here typically runs from somewhere unrelated to the
 * teammate's repo (vitest runs from the package dir, a dispatcher
 * may run from a parent), and a `process.cwd()` fallback leaks
 * the caller's absolute path into resume / history error
 * messages — which the conformance harness then bakes into goldens.
 */
export function cwdForName(name: string, env: NativeEnv): string {
  const identity = readIdentity(name)
  if (identity !== null) return normalizeExistingCwd(identity.cwd)
  const archived = readArchivedIdentity(name)
  if (archived !== null) return normalizeExistingCwd(archived.cwd)
  const codexMetaCwd = readCodexMeta(name)?.cwd
  if (codexMetaCwd !== undefined) return normalizeExistingCwd(codexMetaCwd)
  const codexBaseCwd = readBaseRecord(name)?.cwd
  if (codexBaseCwd !== undefined) return normalizeExistingCwd(codexBaseCwd)
  const dispatcherChild = join(env.dispatcherDir, name)
  if (isDirectory(dispatcherChild)) return normalizeExistingCwd(dispatcherChild)
  return normalizeExistingCwd(env.dispatcherDir)
}

/** Whether `tm resume` can probe a teammate's cwd for resumable history. */
export function resumeCwdProbeable(name: string, env: NativeEnv): boolean {
  if (readIdentity(name) !== null) return true
  if (readArchivedIdentity(name) !== null) return true
  if (readBaseRecord(name) !== null) return true
  if (readCodexMeta(name) !== null) return true
  const dispatcherChild = join(env.dispatcherDir, name)
  return isDirectory(dispatcherChild)
}

export type CtxWindowOverride = '' | '200k' | '1m'
export type CtxArgs =
  | { repos: string[]; windowOverride: CtxWindowOverride; all: boolean }
  | { error: TmResult }

export function parseCtxArgs(args: readonly string[]): CtxArgs {
  const repos: string[] = []
  let windowOverride: CtxWindowOverride | string = ''
  let all = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--all') {
      all = true
    } else if (arg === '--window') {
      if (i + 1 >= args.length) return { error: { code: 1, stdout: '', stderr: '' } }
      windowOverride = args[i + 1]!
      i++
    } else if (arg.startsWith('--window=')) {
      windowOverride = arg.slice('--window='.length)
    } else if (arg.startsWith('-')) {
      return { error: die(`tm ctx: unknown flag: ${arg}`) }
    } else {
      repos.push(arg)
    }
  }
  if (windowOverride !== '' && windowOverride !== '200k' && windowOverride !== '1m') {
    return { error: die('tm ctx: --window must be 200k or 1m') }
  }
  return { repos, windowOverride: windowOverride as CtxWindowOverride, all }
}

export type ReloadArgs =
  | { readonly all: boolean; readonly repos: readonly string[] }
  | { readonly error: TmResult }

export function parseReloadTargets(rest: readonly string[]): ReloadArgs {
  let all = false
  const repos: string[] = []
  for (const arg of rest) {
    if (arg === '--all') all = true
    else if (arg === '-h' || arg === '--help') {
      return { error: die('usage: tm reload <name>... | --all') }
    } else if (arg.startsWith('-')) {
      return { error: die(`tm reload: unknown flag: ${arg}`) }
    } else {
      repos.push(arg)
    }
  }

  if (all) {
    if (repos.length > 0) return { error: die('tm reload: --all conflicts with explicit names') }
  } else if (repos.length === 0) {
    return { error: die('usage: tm reload <name>... | --all') }
  }
  return { all, repos }
}
