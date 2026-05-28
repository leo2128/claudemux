/**
 * Path builders for every cross-process file the core touches.
 *
 * Path-builder discipline (repo CLAUDE.md, decision cross-process-cross-platform-invariants): every path under
 * `/tmp/teammate-*`, `/tmp/claude-idle/*`, and Claude Code's project-dir root
 * is constructed by a named function here — never by string concatenation at
 * a use site. The `/tmp` protocol is the coupling layer between `tm`, the
 * Bash hooks, and this core; spreading its shape across literals turns the
 * next schema change into a non-atomic multi-file sweep.
 *
 * The hooks are Bash and cannot import this module, so they re-declare the
 * same builders inline (`hooks/on-stop.sh`, `hooks/on-busy.sh`). The shapes
 * here must stay byte-for-byte identical to those — see
 * `.agents/domains/cross-process-protocol.md` for the contract.
 */

import { join } from 'node:path'
import type { TeammateName } from '../engines/types'

/** The root directory the Claude engine's extension files live in. */
const TEAMMATE_ROOT = '/tmp'

/** Root of the per-sid idle/busy/last markers the Claude Code hooks maintain. */
export function idleDir(): string {
  return '/tmp/claude-idle'
}

/** The bare `<sid>` marker — touched by `on-stop.sh` when a turn ends. */
export function idleMarkerFor(sid: string): string {
  return join(idleDir(), sid)
}

/** The `<sid>.busy` marker — present while a session is mid-turn. */
export function busyMarkerFor(sid: string): string {
  return join(idleDir(), `${sid}.busy`)
}

/** The `<sid>.last` file — text of the session's last assistant turn. */
export function lastFileFor(sid: string): string {
  return join(idleDir(), `${sid}.last`)
}

/** `/tmp/teammate-<name>.cwd` — written at spawn; read by SessionStart hook. */
export function cwdFile(name: TeammateName): string {
  return join(TEAMMATE_ROOT, `teammate-${name}.cwd`)
}

/** `/tmp/teammate-<name>.sid` — current session id; updated by SessionStart on `/clear`. */
export function sidFile(name: TeammateName): string {
  return join(TEAMMATE_ROOT, `teammate-${name}.sid`)
}

/** `/tmp/teammate-<name>.ready` — touched by SessionStart; cleared before spawn. */
export function readyFile(name: TeammateName): string {
  return join(TEAMMATE_ROOT, `teammate-${name}.ready`)
}

/** `/tmp/teammate-<name>.send-at` — touched per send; read by the pane-quiet wait fallback. */
export function sendAtFile(name: TeammateName): string {
  return join(TEAMMATE_ROOT, `teammate-${name}.send-at`)
}

/** The session-name prefix every tmux teammate session carries. */
export const TMUX_SESSION_PREFIX = 'teammate-'

/**
 * Compose a teammate name into its tmux session name. Schema 2 made
 * names flat, so the prefix is the only transformation.
 *
 * Example: `flow-auth-7d3a` → `teammate-flow-auth-7d3a`.
 */
export function tmuxSessionName(name: TeammateName): string {
  return `${TMUX_SESSION_PREFIX}${name}`
}

/**
 * Recover the teammate name from a tmux session string, or `null` if
 * the session does not carry the teammate prefix. Schema 2's flat
 * names make this an exact round-trip.
 */
export function decodeTmuxSessionName(session: string): string | null {
  if (!session.startsWith(TMUX_SESSION_PREFIX)) return null
  return session.slice(TMUX_SESSION_PREFIX.length)
}

/**
 * The on-disk worktree path for a teammate. Mirrors Claude Code's
 * `claude --worktree <slug>` layout — `<repo>/.claude/worktrees/<slug>`
 * — so the Claude engine's pre-spawn `.cwd` write and the Codex
 * engine's self-managed `git worktree add` use the same builder.
 */
export function worktreePathFor(repo: string, slug: string): string {
  return `${repo}/.claude/worktrees/${slug}`
}

/**
 * The git branch name `claude --worktree <slug>` creates. Codex's
 * self-managed `git worktree add -b` uses the same branch name so a
 * teammate's worktree layout looks identical whichever engine owns it.
 */
export function worktreeBranchFor(slug: string): string {
  return `worktree-${slug}`
}

/** Per-teammate file fan-out for the Claude engine. */
export interface ClaudeTeammateExtension {
  readonly cwd: string
  readonly sid: string
  readonly ready: string
  readonly sendAt: string
}

/** Materialise the Claude engine's extension paths for one teammate name. */
export function claudeExtensionFor(name: TeammateName): ClaudeTeammateExtension {
  return {
    cwd: cwdFile(name),
    sid: sidFile(name),
    ready: readyFile(name),
    sendAt: sendAtFile(name),
  }
}

/**
 * Encode a filesystem path into Claude Code's project-dir segment — the name
 * of the directory under `~/.claude/projects/` that holds a cwd's transcripts.
 *
 * Claude Code derives that name by replacing every character that is not
 * ASCII-alphanumeric or `-` with `-`. The rule was probed empirically: cwds
 * containing `_`, `+`, `.`, `,`, `:`, `!`, `@`, `;`, or a literal space all
 * land at the same `-bar` directory; only `A-Z`, `a-z`, `0-9`, and `-` survive
 * verbatim. This is an Anthropic-controlled contract, and this is its one
 * source of truth on the TypeScript side (decision cross-process-cross-platform-invariants): every site that
 * locates a project dir routes through here, or the same repo ends up
 * addressed by two different strings.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-')
}
