import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acquireInstanceLock,
  defaultLockDeps,
  releaseInstanceLock,
} from '../src/instance-lock'
import type { InstanceLockDeps } from '../src/instance-lock'

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
