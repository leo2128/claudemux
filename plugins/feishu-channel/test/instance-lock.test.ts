import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireInstanceLock,
  acquireInstanceLockWithEviction,
  defaultLockDeps,
  holderIsEvictable,
  releaseInstanceLock,
} from '../src/instance-lock'
import type { EvictionDeps, InstanceLockDeps } from '../src/instance-lock'
import type { ProcessProbe } from '../src/holder-probe'

/** Deps with a fixed PID and a liveness verdict the test controls. */
function deps(pid: number, alive: boolean | ((pid: number) => boolean)): InstanceLockDeps {
  return {
    pid,
    isProcessAlive: typeof alive === 'function' ? alive : () => alive,
  }
}

describe('instance-lock', () => {
  let dir: string
  let lock: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'feishu-lock-'))
    lock = join(dir, 'connection.lock')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('acquires a free lock and records the PID', () => {
    const result = acquireInstanceLock(lock, deps(1111, true))
    expect(result.acquired).toBe(true)
    expect(readFileSync(lock, 'utf8').trim()).toBe('1111')
  })

  test('creates the state directory if it does not exist yet', () => {
    const nested = join(dir, 'deep', 'channels', 'feishu', 'connection.lock')
    expect(acquireInstanceLock(nested, deps(2222, true)).acquired).toBe(true)
    expect(existsSync(nested)).toBe(true)
  })

  test('a live holder blocks a second acquirer', () => {
    writeFileSync(lock, '2222\n')
    const result = acquireInstanceLock(lock, deps(3333, (p) => p === 2222))
    expect(result.acquired).toBe(false)
    expect(result.holderPid).toBe(2222)
    // The holder's PID is left untouched.
    expect(readFileSync(lock, 'utf8').trim()).toBe('2222')
  })

  test('a stale holder (dead PID) is taken over', () => {
    writeFileSync(lock, '4444\n')
    const result = acquireInstanceLock(lock, deps(5555, false))
    expect(result.acquired).toBe(true)
    expect(readFileSync(lock, 'utf8').trim()).toBe('5555')
  })

  test('a garbled pidfile is treated as stale and reclaimed', () => {
    writeFileSync(lock, 'not-a-pid')
    // isProcessAlive must never be consulted — there is no PID to probe.
    const result = acquireInstanceLock(lock, deps(6666, () => true))
    expect(result.acquired).toBe(true)
    expect(readFileSync(lock, 'utf8').trim()).toBe('6666')
  })

  test('re-acquiring with the same PID still reports the lock held', () => {
    expect(acquireInstanceLock(lock, deps(7777, true)).acquired).toBe(true)
    expect(acquireInstanceLock(lock, deps(7777, true)).acquired).toBe(true)
  })

  test('release removes the lock when this process holds it', () => {
    acquireInstanceLock(lock, deps(8888, true))
    releaseInstanceLock(lock, deps(8888, true))
    expect(existsSync(lock)).toBe(false)
  })

  test('release leaves another process’s lock untouched', () => {
    writeFileSync(lock, '9999\n')
    releaseInstanceLock(lock, deps(1234, true))
    expect(existsSync(lock)).toBe(true)
    expect(readFileSync(lock, 'utf8').trim()).toBe('9999')
  })

  test('release on an absent lock is a no-op', () => {
    expect(() => releaseInstanceLock(lock, deps(1111, true))).not.toThrow()
  })

  test('defaultLockDeps reports this process as alive', () => {
    const d = defaultLockDeps()
    expect(d.pid).toBe(process.pid)
    expect(d.isProcessAlive(process.pid)).toBe(true)
    // PID 0 and negatives are never live processes to claim a lock from.
    expect(d.isProcessAlive(0)).toBe(false)
    expect(d.isProcessAlive(-1)).toBe(false)
  })
})

/** A probe describing a feishu-channel channel server in version directory `version`. */
function serverProbe(version: string): ProcessProbe {
  return {
    command: '/path/to/tsx src/server.ts',
    cwd: `/cache/claudemux/feishu-channel/${version}`,
  }
}

describe('holderIsEvictable', () => {
  const self = '/cache/claudemux/feishu-channel/0.9.0'

  test('an unprobeable holder is never evictable', () => {
    expect(holderIsEvictable(undefined, self)).toBe(false)
  })

  test('a process that is not running server.ts is never evictable', () => {
    const probe: ProcessProbe = { command: 'node unrelated-app.js', cwd: self }
    expect(holderIsEvictable(probe, self)).toBe(false)
  })

  test('a server.ts process outside a version directory is never evictable', () => {
    const probe: ProcessProbe = { command: 'tsx src/server.ts', cwd: '/tmp/scratch' }
    expect(holderIsEvictable(probe, self)).toBe(false)
  })

  test('a same-version channel server is a peer, not evictable', () => {
    expect(holderIsEvictable(serverProbe('0.9.0'), self)).toBe(false)
  })

  test('a different-version channel server is evictable', () => {
    expect(holderIsEvictable(serverProbe('0.5.0'), self)).toBe(true)
  })

  test('a trailing slash does not make a same-version holder look foreign', () => {
    expect(holderIsEvictable(serverProbe('0.9.0'), `${self}/`)).toBe(false)
  })
})

describe('acquireInstanceLockWithEviction', () => {
  let dir: string
  let lock: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'feishu-evict-'))
    lock = join(dir, 'connection.lock')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Eviction deps with a self version directory and test-controlled effects. */
  function evictionDeps(opts: {
    pid: number
    alive: (pid: number) => boolean
    probe?: (pid: number) => ProcessProbe | undefined
    onSignal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
    selfDir?: string
  }): EvictionDeps {
    return {
      pid: opts.pid,
      isProcessAlive: opts.alive,
      selfDir: opts.selfDir ?? '/cache/claudemux/feishu-channel/0.9.0',
      probe: opts.probe ?? (() => undefined),
      signal: opts.onSignal ?? (() => {}),
      sleep: () => Promise.resolve(),
    }
  }

  test('takes a free lock without evicting anything', async () => {
    const signals: string[] = []
    const result = await acquireInstanceLockWithEviction(
      lock,
      evictionDeps({ pid: 1111, alive: () => true, onSignal: (_p, s) => signals.push(s) }),
    )
    expect(result.acquired).toBe(true)
    expect(result.evicted).toBe(false)
    expect(signals).toEqual([])
    expect(readFileSync(lock, 'utf8').trim()).toBe('1111')
  })

  test('reclaims a stale (dead) holder without evicting', async () => {
    writeFileSync(lock, '4444\n')
    const signals: string[] = []
    const result = await acquireInstanceLockWithEviction(
      lock,
      evictionDeps({ pid: 5555, alive: () => false, onSignal: (_p, s) => signals.push(s) }),
    )
    expect(result.acquired).toBe(true)
    expect(result.evicted).toBe(false)
    expect(signals).toEqual([])
    expect(readFileSync(lock, 'utf8').trim()).toBe('5555')
  })

  test('stands by — without signalling — when the holder cannot be probed', async () => {
    writeFileSync(lock, '2222\n')
    const signals: string[] = []
    const result = await acquireInstanceLockWithEviction(
      lock,
      evictionDeps({
        pid: 3333,
        alive: (p) => p === 2222,
        probe: () => undefined,
        onSignal: (_p, s) => signals.push(s),
      }),
    )
    expect(result.acquired).toBe(false)
    expect(result.evicted).toBe(false)
    expect(signals).toEqual([])
    expect(readFileSync(lock, 'utf8').trim()).toBe('2222')
  })

  test('stands by — without signalling — for a same-version peer', async () => {
    writeFileSync(lock, '2222\n')
    const signals: string[] = []
    const result = await acquireInstanceLockWithEviction(
      lock,
      evictionDeps({
        pid: 3333,
        alive: (p) => p === 2222,
        probe: () => serverProbe('0.9.0'),
        onSignal: (_p, s) => signals.push(s),
      }),
    )
    expect(result.acquired).toBe(false)
    expect(result.evicted).toBe(false)
    expect(signals).toEqual([])
  })

  test('evicts an older channel server that exits on SIGTERM', async () => {
    writeFileSync(lock, '4242\n')
    let holderAlive = true
    const signals: string[] = []
    const result = await acquireInstanceLockWithEviction(
      lock,
      evictionDeps({
        pid: 9999,
        alive: (p) => (p === 4242 ? holderAlive : false),
        probe: (p) => (p === 4242 ? serverProbe('0.5.0') : undefined),
        onSignal: (_p, s) => {
          signals.push(s)
          if (s === 'SIGTERM') holderAlive = false
        },
      }),
    )
    expect(result.acquired).toBe(true)
    expect(result.evicted).toBe(true)
    expect(signals).toEqual(['SIGTERM'])
    expect(readFileSync(lock, 'utf8').trim()).toBe('9999')
  })

  test('escalates to SIGKILL when an older server outlives the SIGTERM grace', async () => {
    writeFileSync(lock, '4242\n')
    let holderAlive = true
    const signals: string[] = []
    const result = await acquireInstanceLockWithEviction(
      lock,
      evictionDeps({
        pid: 9999,
        alive: (p) => (p === 4242 ? holderAlive : false),
        probe: (p) => (p === 4242 ? serverProbe('0.5.0') : undefined),
        onSignal: (_p, s) => {
          signals.push(s)
          if (s === 'SIGKILL') holderAlive = false
        },
      }),
    )
    expect(result.acquired).toBe(true)
    expect(result.evicted).toBe(true)
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(readFileSync(lock, 'utf8').trim()).toBe('9999')
  })

  test('reports the lock held when this process is already the holder', async () => {
    writeFileSync(lock, '8888\n')
    const signals: string[] = []
    const result = await acquireInstanceLockWithEviction(
      lock,
      evictionDeps({ pid: 8888, alive: () => true, onSignal: (_p, s) => signals.push(s) }),
    )
    expect(result.acquired).toBe(true)
    expect(result.evicted).toBe(false)
    expect(signals).toEqual([])
  })
})
