/**
 * Single-instance lock for the Feishu inbound connection.
 *
 * The channel plugin loads in every Claude Code session it is enabled for, and
 * each session's MCP server would otherwise open its own Feishu long-connection
 * WebSocket with the same app credentials. Feishu delivers each inbound event
 * to exactly one of an app's connections, so N connections silently split the
 * inbound messages N ways — most messages never reach the session the operator
 * is watching.
 *
 * This lock elects exactly one server process — the holder — to open the
 * inbound WebSocket; every other process stands by. The lock is a pidfile: the
 * holder writes its PID, and another instance treats the file as held only
 * when that PID belongs to a live process. A crashed holder leaves a stale
 * pidfile whose PID is dead, so the next instance reclaims it — a crash can
 * never wedge the channel permanently shut.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Injectable environment for the lock — real values in production, fakes in tests. */
export interface InstanceLockDeps {
  /** The PID this process claims the lock with. */
  pid: number
  /** True when `pid` belongs to a process that is currently alive. */
  isProcessAlive: (pid: number) => boolean
}

/** Outcome of an acquire attempt. */
export interface AcquireResult {
  /** True when this process now holds the lock. */
  acquired: boolean
  /** PID recorded in the lockfile when `acquired` is false; absent if unknown. */
  holderPid?: number
}

/** How many times to retry past a stale lock before yielding to a competitor. */
const MAX_RECLAIM_ATTEMPTS = 3

/**
 * Probe whether `pid` is a live process. Signal 0 runs the kernel's
 * permission/existence check without delivering a signal: it succeeds for a
 * live process, throws `ESRCH` for one that is gone, and throws `EPERM` for a
 * live process this user may not signal (still alive — count it as held).
 */
function realIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The production deps — this process's real PID and a real liveness probe. */
export function defaultLockDeps(): InstanceLockDeps {
  return { pid: process.pid, isProcessAlive: realIsProcessAlive }
}

/**
 * Try to acquire the single-instance lock at `path`.
 *
 * The pidfile is created with the exclusive `wx` flag, an atomic operation, so
 * two instances racing to create it cannot both win. When the file already
 * exists, its PID is probed: a live holder means this instance does not get
 * the lock; a dead (or unreadable) holder means the file is stale and is
 * reclaimed. A competitor reclaiming the same stale file simply wins the
 * exclusive create, and this instance then sees its live PID and stands down.
 */
export function acquireInstanceLock(
  path: string,
  deps: InstanceLockDeps = defaultLockDeps(),
): AcquireResult {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })

  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt++) {
    try {
      writeFileSync(path, `${deps.pid}\n`, { flag: 'wx', mode: 0o600 })
      return { acquired: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }

    const holderPid = readHolderPid(path)
    if (holderPid === deps.pid) return { acquired: true }
    if (holderPid !== undefined && deps.isProcessAlive(holderPid)) {
      return { acquired: false, holderPid }
    }

    // The file is stale — an unreadable/garbled pidfile, or a holder that is
    // gone. Remove it and retry the exclusive create.
    removeIfPresent(path)
  }

  // Lost every reclaim race — a competitor holds it now.
  return { acquired: false, holderPid: readHolderPid(path) }
}

/**
 * Release the lock if this process still holds it. Safe to call from any
 * instance: a stand-by process that never acquired the lock, and a former
 * holder whose file was already reclaimed, both leave the file untouched —
 * only a pidfile that still carries `deps.pid` is removed.
 */
export function releaseInstanceLock(
  path: string,
  deps: InstanceLockDeps = defaultLockDeps(),
): void {
  if (readHolderPid(path) !== deps.pid) return
  removeIfPresent(path)
}

/** Read the PID from the lockfile; `undefined` when missing or not a valid PID. */
function readHolderPid(path: string): number | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  const pid = Number.parseInt(raw.trim(), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/** Delete `path`, treating an already-absent file as success. */
function removeIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
