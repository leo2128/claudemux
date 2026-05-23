/**
 * Path builders for every cross-process file the core touches.
 *
 * Path-builder discipline (repo CLAUDE.md, decision 0004): every path under
 * `/tmp/teammate-*`, `/tmp/claude-idle/*`, and the core's own state directory
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

/** The repo-keyed `.sid` file — stores a teammate's current session_id. */
export function sidFile(repo: string): string {
  return `/tmp/teammate-${repo}.sid`
}

/** The repo-keyed `.cwd` file — the teammate's physical cwd at spawn time. */
export function cwdFile(repo: string): string {
  return `/tmp/teammate-${repo}.cwd`
}

/** The repo-keyed `.send-at` file — the epoch-seconds of the last `tm send`. */
export function sendAtFile(repo: string): string {
  return `/tmp/teammate-${repo}.send-at`
}

/** The repo-keyed `.ready` file — touched by the SessionStart hook once spawned. */
export function readyFile(repo: string): string {
  return `/tmp/teammate-${repo}.ready`
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
 * source of truth on the TypeScript side (decision 0004): every site that
 * locates a project dir routes through here, or the same repo ends up
 * addressed by two different strings.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-')
}
