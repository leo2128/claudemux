/**
 * `tm resume <name> [checkpoint]` — relaunch a previous teammate session.
 *
 * Engine selection priority (literal per the resume-probing design):
 *   1. explicit `--engine` flag       — caller's override, wins unconditionally
 *   2. checkpoint-from-rollout        — a Codex thread-id maps to a rollout
 *      (existing `codexFromRollout` logic — preserves `tm resume <name> <thread-id>`
 *      after `tm kill` has removed the base record)
 *   3. router resolution              — an existing teammate's recorded engine
 *   4. cwd probing                    — both engines are asked whether they
 *      hold history for the teammate's cwd; single candidate auto-routes,
 *      double candidate is an ambiguity error, no candidate is "no resumable
 *      session" — see decision context in the PR.
 *   5. not-found                      — when probing cannot run (cwd unknown)
 *      and the identity router cannot resolve the name.
 */

import { hasClaudeHistoryForCwd } from '../engines/claude/history'
import { hasCodexHistoryForCwd } from '../engines/codex/history'
import { formatResume } from './format'
import { findCodexRolloutFile, readRolloutSessionCwd } from '../engines/codex/rollout'
import { resolveTargetEngine } from './resolve'
import type { Engine } from '../engines/engine'
import type { EngineKind, ResumeRequest, TeammateName } from '../engines/types'
import type { TmResult } from '../tm'
import type { VerbContext } from './context'

/**
 * Recognise a worktree-shaped cwd
 * (`<repo>/.claude/worktrees/<slug>`). The shape is the contract
 * both engines launch worktree teammates under, so the same parser
 * works whether the rollout was written by a Claude or a Codex
 * teammate. Returns `null` when `cwd` does not have the suffix —
 * the caller then falls back to "treat cwd as the repo itself"
 * (`--no-worktree` mode).
 *
 * Exported so the unit test pinning the resume-after-clean-kill
 * recovery shape can target this directly without standing up
 * a real Codex daemon.
 */
export function parseWorktreeCwd(cwd: string): { repo: string; slug: string } | null {
  const m = cwd.match(/^(.*?)\/\.claude\/worktrees\/([^/]+)\/?$/)
  if (m === null) return null
  const repo = m[1] ?? ''
  const slug = m[2] ?? ''
  if (repo.length === 0 || slug.length === 0) return null
  return { repo, slug }
}

export interface ResumeArgs {
  readonly name: TeammateName
  readonly repo: string | null
  readonly cwd: string | null
  readonly worktreeSlug: string | null
  readonly checkpoint: string | null
  readonly prompt: string | null
  readonly displayName: string | null
  /** `tm resume --engine claude|codex` — overrides every other selector. */
  readonly engineHint: EngineKind | null
  /** `~/.claude/projects` (or test override) — needed for Claude-side probing. */
  readonly projectsDir: string
  /**
   * Whether `cwd` was derived from a real source (an existing identity
   * record, a Codex base record/meta, or a dispatcher subdirectory)
   * rather than the last-resort fallback. Probing must skip itself
   * when this is `false`, or it would match the dispatcher's own
   * transcripts and false-route.
   */
  readonly cwdProbeable: boolean
}

function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

async function dispatchResume(engine: Engine, args: ResumeArgs, ctx: VerbContext): Promise<TmResult> {
  const req: ResumeRequest = {
    name: args.name,
    repo: args.repo,
    cwd: args.cwd,
    worktreeSlug: args.worktreeSlug,
    checkpoint: args.checkpoint,
    prompt: args.prompt,
    displayName: args.displayName,
  }
  return formatResume(await engine.resume(req, ctx.engineContext))
}

export async function resumeVerb(args: ResumeArgs, ctx: VerbContext): Promise<TmResult> {
  // 1. Explicit --engine wins unconditionally — caller's override.
  if (args.engineHint !== null) {
    const engine = ctx.engines.get(args.engineHint)
    if (engine === undefined) {
      return die(`resume: --engine ${args.engineHint} is not registered in this process`)
    }
    return dispatchResume(engine, args, ctx)
  }

  // 2. Checkpoint reverse-lookup — a passed thread-id that maps to a
  // Codex rollout. Preserves `tm resume <name> <thread-id>` after
  // `tm kill` has removed the live identity + Codex meta records.
  //
  // After a clean kill, `args.cwd` came from `cwdForName`'s last-resort
  // fallback (no identity → no Codex meta → no `<dispatcherDir>/<name>`
  // dir → dispatcher dir). Spawning the resumed daemon at the
  // dispatcher dir would silently launch follow-up turns in the wrong
  // workspace. The rollout's `session_meta.cwd` header records the
  // daemon's original launch cwd verbatim; use it to override the
  // fallback when the dispatcher would otherwise route blind. When
  // the rollout cwd has the worktree shape
  // (`.../.claude/worktrees/<slug>`), split out `repo` and
  // `worktreeSlug` so the engine re-provisions the worktree if a
  // prior `tm kill` removed it. The identity-known path (no kill, or
  // `--name` matches a live record) already has the right cwd in
  // `args.cwd`, so the override only fires when `cwdForName` could
  // not produce a teammate-specific cwd.
  const codex = ctx.engines.get('codex')
  if (args.checkpoint !== null && codex !== undefined) {
    const rollout = findCodexRolloutFile(args.checkpoint, ctx.engineContext.env)
    if (rollout !== null) {
      const rolloutCwd = readRolloutSessionCwd(rollout.path)
      const shouldRecover = rolloutCwd !== null && (args.cwd === null || !args.cwdProbeable)
      let recovered = args
      if (shouldRecover && rolloutCwd !== null) {
        const parts = parseWorktreeCwd(rolloutCwd)
        recovered = parts === null
          ? { ...args, cwd: rolloutCwd, repo: rolloutCwd, worktreeSlug: null }
          : { ...args, cwd: rolloutCwd, repo: parts.repo, worktreeSlug: parts.slug }
      }
      return dispatchResume(codex, recovered, ctx)
    }
  }

  // 3. Router — an existing teammate's recorded engine.
  const resolved = await ctx.router.resolve(args.name)
  if (resolved !== null) {
    return dispatchResume(resolved.engine, args, ctx)
  }

  // 4. cwd probing — single candidate auto-routes; double = ambiguity error.
  // Probing is only meaningful when there is no checkpoint to disambiguate,
  // and only safe when the cwd actually points at the teammate's repo.
  if (args.checkpoint === null && args.cwd !== null && args.cwdProbeable) {
    const claude = ctx.engines.get('claude')
    const codexHas = codex !== undefined && hasCodexHistoryForCwd(args.cwd, ctx.engineContext.env)
    const claudeHas = claude !== undefined && hasClaudeHistoryForCwd(args.cwd, args.projectsDir)

    if (codexHas && claudeHas) {
      return die(
        `resume: ambiguous — both codex and claude have resumable history for ` +
          `cwd ${args.cwd}. Pass --engine codex|claude, or give an explicit ` +
          `<sid> (claude) / <thread-id> (codex).`,
      )
    }
    if (codexHas) return dispatchResume(codex!, args, ctx)
    if (claudeHas) return dispatchResume(claude!, args, ctx)
    return die(
      `resume: no resumable session for ${args.name} — no Claude transcript ` +
        `under projectsDir and no Codex rollout for cwd ${args.cwd}. ` +
        `To start a new session, use 'tm spawn ${args.name} [--engine codex|claude]'.`,
    )
  }

  // 5. Not found — cwd is unknown (or checkpoint passed but unmatched). The
  // production router may have migrated a live pre-identity teammate above;
  // if resolution is still empty, there is no engine-safe target.
  const engine = await resolveTargetEngine(args.name, ctx)
  if ('code' in engine) return engine
  return dispatchResume(engine, args, ctx)
}
