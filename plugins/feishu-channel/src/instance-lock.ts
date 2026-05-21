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

import { probeProcess } from './holder-probe'
import type { ProcessProbe } from './holder-probe'

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

/**
 * The extra capabilities `acquireInstanceLockWithEviction` needs on top of a
 * plain acquire: this server's own version directory, a way to inspect the
 * lock holder, a way to signal it, and a wait between a signal and the
 * liveness re-check. Every effect is injectable so the eviction decision is
 * testable without real processes.
 */
export interface EvictionDeps extends InstanceLockDeps {
  /**
   * This server's own version directory — the cwd it was launched in. A
   * holder running from a different directory is a different plugin version.
   */
  selfDir: string
  /** Inspect a live PID; `undefined` when it cannot be inspected. */
  probe: (pid: number) => ProcessProbe | undefined
  /** Send `signal` to `pid`; a failure (already gone, not permitted) is swallowed. */
  signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  /** Resolve after `ms` — the gap between a termination signal and the re-check. */
  sleep: (ms: number) => Promise<void>
}

/** Outcome of `acquireInstanceLockWithEviction`: an `AcquireResult` plus whether a holder was evicted. */
export interface EvictionResult extends AcquireResult {
  /** True when an older channel server was terminated to take the lock. */
  evicted: boolean
}

/** The production eviction deps — real PID, liveness probe, process inspection, and signalling. */
export function defaultEvictionDeps(): EvictionDeps {
  return {
    ...defaultLockDeps(),
    selfDir: process.cwd(),
    probe: probeProcess,
    signal: (pid, sig) => {
      try {
        process.kill(pid, sig)
      } catch {
        // The holder is already gone, or this user may not signal it — either
        // way there is nothing more to do, and the post-signal liveness check
        // decides whether the lock can be reclaimed.
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }
}

/** Grace period after SIGTERM before escalating to SIGKILL. */
const EVICT_SIGTERM_GRACE_MS = 5_000
/** Grace period after SIGKILL before the wait gives up. */
const EVICT_SIGKILL_GRACE_MS = 2_000
/** How often the post-signal wait re-checks whether the holder has exited. */
const EVICT_POLL_MS = 200

/**
 * Decide whether the lock holder is a channel server this process should
 * evict. It is — and only is — when the holder is positively identified as a
 * feishu-channel `server.ts` process whose version directory differs from
 * this server's own. A probe that could not read the holder, a holder that is
 * not a channel server, and a holder of the *same* version (a legitimate
 * same-build peer) are all left running. Any uncertainty resolves to "do not
 * evict", so an unrelated process can never be killed.
 */
export function holderIsEvictable(
  probe: ProcessProbe | undefined,
  selfDir: string,
): boolean {
  if (!probe) return false
  const holderDir = channelServerVersionDir(probe)
  if (holderDir === undefined) return false
  return trimSlash(holderDir) !== trimSlash(selfDir)
}

/**
 * The version directory of a feishu-channel channel server, or `undefined`
 * when the probe is not such a server. A channel server runs the `server.ts`
 * entry point with its cwd set to a plugin-cache version directory —
 * `.../feishu-channel/<version>`. Both facts must hold: the pair is specific
 * enough that no unrelated process matches it.
 */
function channelServerVersionDir(probe: ProcessProbe): string | undefined {
  if (!probe.command.includes('server.ts')) return undefined
  return /(?:^|\/)feishu-channel\/[^/]+$/.test(probe.cwd) ? probe.cwd : undefined
}

/** Drop a single trailing slash so two directory paths compare cleanly. */
function trimSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path
}

/**
 * Acquire the single-instance lock, evicting an older channel server that
 * holds it.
 *
 * A plain acquire is tried first. When it loses to a live holder, the holder
 * is inspected: if it is a feishu-channel channel server of a *different*
 * version (see `holderIsEvictable`), it is terminated — SIGTERM first so it
 * closes its Feishu connection and releases the lockfile itself, escalating
 * to SIGKILL only if it overruns the grace window — and the lock is then
 * reclaimed. A holder that cannot be confirmed as a different-version channel
 * server is left untouched, and this call reports the lock as not acquired,
 * exactly as a plain acquire would.
 *
 * This is the startup path. The standby poll deliberately keeps using the
 * plain `acquireInstanceLock`: eviction belongs to the moment a new server
 * launches, and repeating it on every poll could let two servers of different
 * versions evict each other in a loop.
 */
export async function acquireInstanceLockWithEviction(
  path: string,
  deps: EvictionDeps = defaultEvictionDeps(),
): Promise<EvictionResult> {
  const first = acquireInstanceLock(path, deps)
  if (first.acquired) return { ...first, evicted: false }

  const holderPid = first.holderPid
  if (holderPid === undefined || holderPid === deps.pid) {
    return { ...first, evicted: false }
  }

  if (!holderIsEvictable(deps.probe(holderPid), deps.selfDir)) {
    return { ...first, evicted: false }
  }

  deps.signal(holderPid, 'SIGTERM')
  if (!(await waitForExit(holderPid, deps, EVICT_SIGTERM_GRACE_MS))) {
    deps.signal(holderPid, 'SIGKILL')
    await waitForExit(holderPid, deps, EVICT_SIGKILL_GRACE_MS)
  }

  // The holder either released the lockfile on its way out or was killed
  // leaving a stale pidfile; either way its PID is now dead, so the reclaim
  // path inside `acquireInstanceLock` takes the lock.
  const second = acquireInstanceLock(path, deps)
  return { ...second, evicted: true }
}

/**
 * Poll the holder's liveness until it has exited or `budgetMs` elapses.
 * Resolves `true` once the holder is gone, `false` if it outlives the budget.
 */
async function waitForExit(
  pid: number,
  deps: EvictionDeps,
  budgetMs: number,
): Promise<boolean> {
  for (let waited = 0; waited < budgetMs; waited += EVICT_POLL_MS) {
    if (!deps.isProcessAlive(pid)) return true
    await deps.sleep(EVICT_POLL_MS)
  }
  return !deps.isProcessAlive(pid)
}
