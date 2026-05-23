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

/**
 * Root of the codex-daemon process registry. One subdirectory per codex
 * teammate, holding that daemon's socket node, pid file, and bookkeeping.
 *
 * Per teammate rather than flat files keyed by suffix (the Claude-side
 * `/tmp/teammate-<repo>.{sid,cwd,…}` shape) because a codex daemon owns
 * substantially more state than a tmux session does — socket, pid,
 * thread id, last-seen liveness, spawn-time config — and a directory makes
 * reap atomic: `rm -rf` the dir tears the whole entry down in one move.
 *
 * Decision 0019 §5: this registry is `tm`'s authoritative record of the
 * spawned daemon set. There is no in-memory mirror; every invocation
 * reconstructs from these files.
 *
 * `CLAUDEMUX_CODEX_REGISTRY_ROOT` overrides the default — the test seam
 * that gives the supervisor / doctor / verb test files a private root
 * each, so parallel `vitest` workers never race over the same
 * `/tmp/teammate-codex/` directory. Production never sets this.
 */
export function codexRegistryRoot(): string {
  // `||` not `??`: an empty `CLAUDEMUX_CODEX_REGISTRY_ROOT` (a partial
  // shell expansion produces one) is treated as "unset", matching the
  // bash `${VAR:-default}` convention this codebase chose elsewhere
  // (see cli.ts:160-170). With `??`, an empty string would propagate
  // and every registry path would resolve under the filesystem root.
  return process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] || '/tmp/teammate-codex'
}

/** This teammate's registry subdirectory — created by `tm spawn codex-<n>`. */
export function codexTeammateDir(name: string): string {
  return join(codexRegistryRoot(), name)
}

/**
 * The unix-domain socket node this teammate's `codex app-server` listens on.
 * The daemon is spawned with `--listen unix://<this path>`; the client
 * connects to the same path. Living inside the teammate's registry directory
 * keeps lifecycle parity — when the entry is reaped the socket node goes
 * with it.
 */
export function codexSocketPath(name: string): string {
  return join(codexTeammateDir(name), 'socket')
}

/** Daemon pid, ascii-decimal, single line. Read by liveness probes. */
export function codexPidFile(name: string): string {
  return join(codexTeammateDir(name), 'pid')
}

/** Epoch-seconds of the daemon spawn, ascii-decimal. Diagnostic only. */
export function codexStartedAtFile(name: string): string {
  return join(codexTeammateDir(name), 'started-at')
}

/**
 * The teammate's current codex thread id, as returned by `thread/start`.
 * Absent before the first turn completes. `tm send` reads this to route a
 * `turn/start` onto the right thread; `tm doctor` reports it for inspection.
 */
export function codexThreadFile(name: string): string {
  return join(codexTeammateDir(name), 'thread')
}

/**
 * Epoch-seconds of the last successful RPC against this daemon. Updated by
 * every verb that completes a round-trip; consulted by `tm doctor` to
 * distinguish a quiet-but-healthy daemon from a hung one. Distinct from
 * `started-at` — the latter never changes after spawn.
 */
export function codexLastSeenFile(name: string): string {
  return join(codexTeammateDir(name), 'last-seen')
}

/**
 * Spawn-time configuration (model, reasoning effort, sandbox mode,
 * approval policy, …) — the inputs `tm spawn` baked into the daemon, kept
 * so `tm doctor` and a future `tm resume codex-<n>` can read them back.
 * JSON-encoded text file.
 */
export function codexMetaFile(name: string): string {
  return join(codexTeammateDir(name), 'meta.json')
}
