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

import { homedir } from 'node:os'
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

/** The core's own state directory — persistent, under `~/.claude/`. */
export function coreStateDir(): string {
  return join(homedir(), '.claude', 'claudemux')
}

/**
 * The teammate registry file. Lives under `~/.claude/` rather than `/tmp` so
 * it survives a reboot — the registry is the core's authoritative record of
 * the teammate set and must outlive a core restart (Phase A exit gate).
 */
export function registryFile(): string {
  return join(coreStateDir(), 'registry.json')
}

/**
 * The unix-domain socket the resident core's MCP server listens on. In `/tmp`
 * on purpose: the socket is an ephemeral rendezvous point, recreated on every
 * core start, with nothing to preserve across a reboot.
 */
export function coreSocketPath(): string {
  return '/tmp/claudemux-core.sock'
}
