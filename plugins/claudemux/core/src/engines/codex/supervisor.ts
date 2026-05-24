/**
 * Process supervision for the codex app-server daemons.
 *
 * Decision 0019 §5 puts daemon lifecycle on claudemux: the codex
 * `app-server` is a long-lived process that outlives any single `tm`
 * invocation, and with no resident core to hold it, `tm` owns spawning,
 * liveness checking, and reaping. The state lives on the filesystem under
 * `/tmp/teammate-codex/<name>/` — the path builders are in
 * [`persistence.ts`](./persistence.ts), this module is the *operations* on top.
 *
 * What this module does **not** do:
 *
 *   - It does not talk the protocol. The WebSocket client lives in
 *     [`rpc.ts`](./rpc.ts); a verb opens a connection to
 *     `codexSocketPath(name)` after the supervisor has reconciled the
 *     daemon. Lifecycle and traffic are kept on separate layers so a
 *     verb that fails to deliver a turn does not get confused for a
 *     verb whose daemon was never up.
 *   - It does not know about teammate semantics (one daemon per repo,
 *     ask-mode pool, etc.). The `name` is opaque here — the verb code
 *     decides what name to spawn under.
 */

import {
  spawn as spawnChild,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
import { dirname, join } from 'node:path'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs'

import {
  codexBorrowLockFile,
  codexLastSeenFile,
  codexMetaFile,
  codexPidFile,
  codexRegistryRoot,
  codexSocketPath,
  codexStartedAtFile,
  codexStderrLogFile,
  codexTeammateDir,
  codexThreadFile,
  codexStdoutLogFile,
} from './persistence.js'
import { validateTeammateName } from '../../identity/name.js'

/** Snapshot of one daemon's on-disk state. `null` for a missing entry. */
export interface DaemonState {
  name: string
  pid: number
  startedAt: number
  socketPath: string
  threadId: string | null
  lastSeen: number | null
}

export class CodexDaemonSpawnInProgressError extends Error {
  constructor(name: string) {
    super(`codex daemon '${name}' is already being spawned`)
    this.name = 'CodexDaemonSpawnInProgressError'
  }
}

export class CodexDaemonAlreadyAliveError extends Error {
  constructor(name: string, pid: number | string) {
    super(`codex daemon '${name}' is already alive (pid ${pid}); reap it first with tm doctor / tm kill`)
    this.name = 'CodexDaemonAlreadyAliveError'
  }
}

export interface SpawnDaemonOptions {
  /** The teammate name (the registry subdirectory name). */
  name: string
  /**
   * The codex executable. Default `'codex'` — relies on `PATH`. Tests
   * pass an absolute path to a fake binary; the live integration suite
   * relies on the user's installed `codex`.
   */
  binPath?: string
  /**
   * Extra args to append after `app-server --listen unix://<socket>`.
   * The supervisor itself sets `--listen`; everything else (model,
   * approval policy, sandbox) is the caller's choice.
   */
  extraArgs?: string[]
  /** Working directory for the spawned daemon. Default `process.cwd()`. */
  cwd?: string
  /** Environment for the spawned daemon. Default `process.env`. */
  env?: NodeJS.ProcessEnv
  /**
   * Ready-probe timeout in milliseconds — how long the supervisor will
   * wait for the daemon to bind its listen socket before treating spawn
   * as a failure. Default 10000ms.
   */
  readyTimeoutMs?: number
  /**
   * JSON-serializable spawn-time configuration (model, reasoning effort,
   * approval policy, …). Persisted to `meta.json` so `tm doctor` and a
   * future `tm resume` can read it back. Pass `null` to skip writing.
   */
  meta?: unknown
}

/** Atomic write: write to a sibling .tmp file and rename into place. */
function atomicWrite(path: string, content: string): void {
  const tmpPath = `${path}.tmp`
  const fd = openSync(tmpPath, 'w', 0o600)
  try {
    writeSync(fd, content)
  } finally {
    closeSync(fd)
  }
  renameSync(tmpPath, path)
}

function readIntFile(path: string): number | null {
  try {
    const txt = readFileSync(path, 'utf8').trim()
    if (txt === '') return null
    const n = Number.parseInt(txt, 10)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim() || null
  } catch {
    return null
  }
}

function clearStaleBorrowLock(name: string): void {
  const lockPath = codexBorrowLockFile(name)
  const pid = readIntFile(lockPath)
  if (pid === null) return
  if (!isProcessAlive(pid)) rmSync(lockPath, { force: true })
}

function codexSpawnLockFile(name: string): string {
  return `${codexTeammateDir(name)}.spawn.lock`
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/** `true` if `pid` names a live process this uid can signal. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    // The 0 signal probes for the process without delivering anything;
    // throws ESRCH if there is no such pid, EPERM if it exists but is
    // owned by another uid (which we count as "alive but we cannot reap"
    // — still a live process). The other errnos are pathological and
    // counted as "not alive" to keep the caller moving.
    process.kill(pid, 0)
    return true
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code
    if (errno === 'EPERM') return true
    return false
  }
}

/**
 * Send `signal` to every process in the group led by `pgid`.
 *
 * The codex CLI is a node wrapper that `spawn`s the real rust binary
 * as a child, so a spawned daemon is two pids: the wrapper (PPID == us,
 * which we record) and the rust process (PPID == wrapper). Both land
 * in the same process group, with the wrapper as the group leader —
 * `child_process.spawn({ detached: true })` arranges this on POSIX,
 * no explicit `setpgid` needed.
 *
 * Killing only the leader pid (the historical behaviour) left the
 * child reparented to init and quietly consuming the unix socket;
 * `tm doctor` would `rm -rf` the registry directory but the rust
 * process would keep running until the box rebooted. The dispatcher
 * found 11 leaked codex processes from a single afternoon of stage 4
 * dogfooding this way.
 *
 * Posix `kill(-pgid, sig)` delivers to every process in the group,
 * including the reparented child. Node's `process.kill` passes the
 * negative pid through unchanged. ESRCH (empty group, every member
 * has exited) is the expected idempotent case; EPERM (the caller's
 * uid cannot signal the target — rare for processes we spawned, but
 * possible if a process has setuid'd to a different uid post-spawn)
 * is also swallowed as "nothing more we can do from here". Both
 * count as success from this function's point of view.
 */
export function killProcessGroup(pgid: number, signal: NodeJS.Signals | number): void {
  if (!Number.isFinite(pgid) || pgid <= 0) return
  try {
    process.kill(-pgid, signal)
  } catch (e) {
    const errno = (e as NodeJS.ErrnoException).code
    if (errno === 'ESRCH' || errno === 'EPERM') return
    // Anything else (EINVAL on an unsupported signal, etc) is the
    // caller's bug, not a runtime condition — let it surface.
    throw e
  }
}

/** Read the on-disk state for one daemon. `null` if no registry entry. */
export function readDaemonState(name: string): DaemonState | null {
  const pid = readIntFile(codexPidFile(name))
  const startedAt = readIntFile(codexStartedAtFile(name))
  if (pid === null || startedAt === null) return null
  return {
    name,
    pid,
    startedAt,
    socketPath: codexSocketPath(name),
    threadId: readTextFile(codexThreadFile(name)),
    lastSeen: readIntFile(codexLastSeenFile(name)),
  }
}

/** Is the daemon at `name` alive right now? */
export function daemonAlive(name: string): boolean {
  const state = readDaemonState(name)
  if (state === null) return false
  return isProcessAlive(state.pid)
}

/** Is a spawn currently reserving or starting this daemon? */
export function daemonSpawnInProgress(name: string): boolean {
  const lockPath = codexSpawnLockFile(name)
  const pid = readIntFile(lockPath)
  if (pid === null) return existsSync(lockPath)
  if (isProcessAlive(pid)) return true
  rmSync(lockPath, { force: true })
  return false
}

/** Names of every registry entry, alive or stale. */
export function listDaemons(): string[] {
  try {
    const root = codexRegistryRoot()
    const names: string[] = []
    const walk = (dir: string, prefix: string): void => {
      if (prefix.length > 0 && existsSync(join(dir, 'pid'))) names.push(prefix)
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const childPrefix = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
        walk(join(dir, entry.name), childPrefix)
      }
    }
    walk(root, '')
    return names.filter((name) => validateTeammateName(name).kind === 'ok').sort()
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
}

/** Is a codex daemon currently borrowed by a direct turn (`send` / `ask`)? */
export function daemonBorrowed(name: string): boolean {
  clearStaleBorrowLock(name)
  return existsSync(codexBorrowLockFile(name))
}

/** Try to borrow a daemon for one direct turn. Returns false when another caller holds it. */
export function tryBorrowDaemon(name: string): boolean {
  clearStaleBorrowLock(name)
  try {
    const fd = openSync(codexBorrowLockFile(name), 'wx', 0o600)
    try {
      writeSync(fd, `${process.pid}\n`)
    } finally {
      closeSync(fd)
    }
    return true
  } catch {
    return false
  }
}

/** Release a daemon borrow lock. Idempotent. */
export function releaseDaemonBorrow(name: string): void {
  rmSync(codexBorrowLockFile(name), { force: true })
}

function removeSelfRegistry(name: string): void {
  for (const file of [
    codexPidFile(name),
    codexSocketPath(name),
    codexStartedAtFile(name),
    codexThreadFile(name),
    codexLastSeenFile(name),
    codexStdoutLogFile(name),
    codexStderrLogFile(name),
    codexMetaFile(name),
    codexBorrowLockFile(name),
  ]) {
    rmSync(file, { force: true })
  }
  try {
    rmdirSync(codexTeammateDir(name))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw e
  }
}

/**
 * Spawn one `codex app-server` daemon, detached so it outlives this `tm`
 * invocation. Resolves once the listen socket exists on disk.
 *
 * On failure the daemon is killed (if it managed to start) and the
 * registry entry torn back down — a half-spawned daemon is worse than
 * none, because subsequent `tm` calls would mistake it for live.
 */
export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<DaemonState> {
  const { name } = opts
  const dir = codexTeammateDir(name)
  const socketPath = codexSocketPath(name)
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10000
  const spawnLock = codexSpawnLockFile(name)
  mkdirSync(dirname(spawnLock), { recursive: true })
  let lockFd: number | null = null
  try {
    lockFd = openSync(spawnLock, 'wx', 0o600)
    writeSync(lockFd, `${process.pid}\n`)
  } catch {
    throw new CodexDaemonSpawnInProgressError(name)
  }

  try {
    if (daemonAlive(name)) {
      throw new CodexDaemonAlreadyAliveError(name, readDaemonState(name)?.pid ?? '?')
    }
    // Stale entry — torn down first so we never carry a previous pid forward.
    removeSelfRegistry(name)
    mkdirSync(dir, { recursive: true })

    const state = await spawnDaemonUnlocked(opts, dir, socketPath, readyTimeoutMs)
    return state
  } finally {
    if (lockFd !== null) closeSync(lockFd)
    rmSync(spawnLock, { force: true })
  }
}

async function spawnDaemonUnlocked(
  opts: SpawnDaemonOptions,
  dir: string,
  socketPath: string,
  readyTimeoutMs: number,
): Promise<DaemonState> {
  const { name } = opts
  // Precedence: explicit `opts.binPath` (tests) > `CLAUDEMUX_CODEX_BIN`
  // env override (the integration-suite seam) > the default `'codex'`
  // on PATH (production). The env hook lets the live-codex suite point
  // at a non-default codex install without surgery on verb code.
  //
  // `||` not `??` for the env step: an empty string in the env is treated
  // as "unset" (matching the bash `${VAR:-default}` convention this
  // codebase chose elsewhere — see cli.ts:160-170). `opts.binPath` keeps
  // `??` because an empty explicit option from a test would be a real
  // intent to disable the binary, not a default-trigger.
  const binPath =
    opts.binPath ?? (process.env['CLAUDEMUX_CODEX_BIN'] || 'codex')
  const args = ['app-server', '--listen', `unix://${socketPath}`, ...(opts.extraArgs ?? [])]
  // Daemon stdio:
  //   stdin  → /dev/null (ignored) — codex app-server is a pure socket server.
  //   stdout → `<dir>/stdout.log`  — diagnostic; usually empty.
  //   stderr → `<dir>/stderr.log`  — load-bearing. The codex protocol is
  //     `[experimental]`; when a request bounces or a turn aborts, codex
  //     writes its reason to stderr. Routing this to /dev/null hid the
  //     reason during stage 4 turn-roundtrip debugging — leave it on disk
  //     under the registry directory so `tail -f /tmp/teammate-codex/<n>/stderr.log`
  //     is one step away. The teammate's reap removes the directory and
  //     the log files with it.
  const stdoutLog = codexStdoutLogFile(name)
  const stderrLog = codexStderrLogFile(name)
  const stdoutFd = openSync(stdoutLog, 'a', 0o600)
  const stderrFd = openSync(stderrLog, 'a', 0o600)
  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    detached: true,
    stdio: ['ignore', stdoutFd, stderrFd],
  }

  let child: ChildProcess
  try {
    child = await new Promise<ChildProcess>((resolve, reject) => {
      let settled = false
      const c = spawnChild(binPath, args, spawnOpts)
      // Listening for `error` separately is mandatory — ENOENT (bad
      // binPath) and EACCES (no exec bit) reach us as an `error` event,
      // not a thrown exception from spawn(). Without this listener
      // they become unhandled exceptions.
      c.once('error', (e) => {
        if (settled) return
        settled = true
        reject(e instanceof Error ? e : new Error(String(e)))
      })
      // `spawn` fires once the child has been spawned successfully —
      // after this, we know the OS handed us a real pid.
      c.once('spawn', () => {
        if (settled) return
        settled = true
        resolve(c)
      })
    })
  } catch (e) {
    closeSync(stdoutFd)
    closeSync(stderrFd)
    removeSelfRegistry(name)
    throw new Error(
      `codex daemon '${name}' failed to spawn ${binPath}: ${(e as Error).message}`,
    )
  }
  // The child holds its own duplicated fds for stdout/stderr after spawn;
  // the parent's copies can be released so they don't leak across many
  // spawn calls in long-running tests.
  closeSync(stdoutFd)
  closeSync(stderrFd)
  // `unref` releases the parent's event loop from the child — the daemon
  // keeps running after this Node process exits.
  child.unref()
  // Future `error` emissions (post-spawn) would still be unhandled. The
  // child is detached and stdio-ignored, so the only thing left that
  // could emit is a kill-signal handler failing; swallow it rather than
  // crash the supervisor.
  child.on('error', () => { /* daemon-side error, can no longer affect this invocation */ })

  const pid = child.pid
  if (pid === undefined) {
    removeSelfRegistry(name)
    throw new Error(`codex daemon '${name}' spawned without a pid`)
  }

  const startedAt = nowSec()
  atomicWrite(codexPidFile(name), `${pid}\n`)
  atomicWrite(codexStartedAtFile(name), `${startedAt}\n`)
  if (opts.meta !== undefined && opts.meta !== null) {
    atomicWrite(codexMetaFile(name), JSON.stringify(opts.meta, null, 2) + '\n')
  }

  try {
    await waitForSocket(socketPath, pid, readyTimeoutMs)
  } catch (e) {
    // Daemon failed its readiness probe — kill it (if alive) and tear the
    // registry entry back down. We do not want a half-spawned daemon
    // lingering with a pid the next `tm` call would treat as healthy.
    // Group-kill, not pid-kill — the codex node wrapper has already
    // spawned the rust binary by the time `waitForSocket` times out
    // in some failure modes, and a leader-only kill would orphan it.
    killProcessGroup(pid, 'SIGKILL')
    removeSelfRegistry(name)
    throw e
  }

  return {
    name,
    pid,
    startedAt,
    socketPath,
    threadId: null,
    lastSeen: null,
  }
}

/**
 * Wait for `path` to exist on disk while `pid` stays alive. Returns when
 * the socket appears, rejects when the process dies first or the deadline
 * is reached. The poll interval is 25ms — fast enough that a healthy
 * daemon (cold-start is a few hundred ms) clears the wait in a few ticks.
 */
async function waitForSocket(
  path: string,
  pid: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      // A socket node is `S_IFSOCK`; a stale regular file at the same
      // path would also pass `existsSync`. Tighten the check so we only
      // resolve when the daemon actually bound.
      try {
        const st = statSync(path)
        if (st.isSocket()) return
      } catch { /* race with daemon creating it — keep polling */ }
    }
    if (!isProcessAlive(pid)) {
      throw new Error(
        `codex daemon (pid ${pid}) exited before binding ${path}`,
      )
    }
    await new Promise<void>((res) => setTimeout(res, 25))
  }
  throw new Error(
    `codex daemon (pid ${pid}) did not bind ${path} within ${timeoutMs}ms`,
  )
}

/**
 * Tear a daemon down: SIGTERM the whole process group, give it 1s to
 * exit cleanly, then SIGKILL the group, then remove this teammate's
 * registry files. Idempotent — a missing entry, an already-dead leader,
 * or a group that no longer has any members is not an error.
 *
 * Group-kill (`killProcessGroup`) rather than pid-kill is load-bearing:
 * the codex node wrapper `spawn`s the rust binary as a child in its
 * own process group; a SIGKILL to only the leader leaves the child
 * reparented to init and still serving the unix socket. See the
 * `killProcessGroup` docstring for the dispatcher-found orphan
 * incident this fixes.
 *
 * The orphan-cleanup path matters even when the registry says the
 * leader is dead — the group can still have a reparented member —
 * so the SIGKILL fires unconditionally before registry cleanup.
 */
export async function reapDaemon(name: string): Promise<void> {
  const state = readDaemonState(name)
  if (state !== null) {
    if (isProcessAlive(state.pid)) {
      killProcessGroup(state.pid, 'SIGTERM')
      const deadline = Date.now() + 1000
      while (Date.now() < deadline) {
        if (!isProcessAlive(state.pid)) break
        await new Promise<void>((res) => setTimeout(res, 25))
      }
    }
    // Always SIGKILL the group, even if the leader is already dead —
    // an orphan (the wrapper's child after the wrapper exited) shows
    // up here as "leader gone, group still has members" and is the
    // exact case we are guarding against.
    killProcessGroup(state.pid, 'SIGKILL')
  }
  removeSelfRegistry(name)
}

/** Touch `last-seen` for `name` — call after a successful RPC. */
export function touchLastSeen(name: string): void {
  writeFileSync(codexLastSeenFile(name), `${nowSec()}\n`)
}

/** Persist the daemon's current thread id (`tm send` writes this after `thread/start`). */
export function writeThreadId(name: string, threadId: string): void {
  atomicWrite(codexThreadFile(name), `${threadId}\n`)
}
