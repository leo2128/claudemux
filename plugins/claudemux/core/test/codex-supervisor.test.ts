/**
 * Unit tests for the codex daemon supervisor.
 *
 * A real `codex app-server` cannot run in CI; the tests use the
 * `test/fixtures/codex-fake/codex` shim — a node script that accepts the
 * same `app-server --listen unix://<path>` invocation, binds a unix
 * socket, speaks the minimal JSON-RPC subset used by engine tests, and
 * sleeps. That is enough surface to pin the supervisor's lifecycle
 * contract (spawn, liveness probe, restart, reap).
 *
 * The registry root is repointed at a per-test tmp directory via the
 * teammate-name namespacing — we never write under the real
 * `/tmp/teammate-codex/` here, so a CI runner with that directory
 * already populated stays untouched.
 */

import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  daemonAlive,
  isProcessAlive,
  listDaemons,
  reapDaemon,
  readDaemonState,
  spawnDaemon,
} from '../src/engines/codex/supervisor'
import {
  codexPidFile,
  codexSocketPath,
  codexTeammateDir,
} from '../src/engines/codex/persistence'
import { spawnCapture } from '../src/proc'

/**
 * Return every pid in the process group whose leader is `pgid`. `pgrep
 * -g <pgid>` is available on both macOS (BSD pgrep) and Linux (procps
 * pgrep). Returns the empty array if the group has no members — the
 * exit code is 1 in that case, which spawnCapture surfaces as `code:1`
 * with empty stdout.
 */
async function pgidMembers(pgid: number): Promise<number[]> {
  const result = await spawnCapture(['pgrep', '-g', String(pgid)])
  return result.stdout
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0)
}

/**
 * Poll `produce` every 25ms until `predicate` returns true or `timeoutMs`
 * elapses. Returns the last produced value; throws if the predicate is
 * never satisfied within the budget. Replaces single hard-coded sleeps
 * in tests that wait for an asynchronous side effect (a spawned child
 * appearing in a process group, a pid file being written, etc).
 */
async function pollFor<T>(
  produce: () => Promise<T> | T,
  predicate: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let value = await produce()
  while (!predicate(value)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `pollFor: predicate not satisfied within ${timeoutMs}ms (last value: ${JSON.stringify(value)})`,
      )
    }
    await new Promise((res) => setTimeout(res, 25))
    value = await produce()
  }
  return value
}

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_CODEX = resolve(HERE, 'fixtures', 'codex-fake', 'codex')

// One test name per test so registry entries never collide between tests
// running in parallel. The supervisor's registry root is hard-coded under
// `/tmp/teammate-codex/`; we drop our entries into a unique subdir name
// each time.
let nameUnder: () => string
let toReap: string[]
let suffixDir: string
let savedRegistryRoot: string | undefined

beforeEach(() => {
  // Short root under `/tmp` rather than under `$TMPDIR` (macOS deep
  // path) — the daemon's unix socket lives at
  // `<root>/<name>/socket` and macOS caps that path at ~104 chars.
  suffixDir = mkdtempSync('/tmp/cmxs-')
  // Each test file gets its own registry root so parallel vitest workers
  // never race over `/tmp/teammate-codex/`. The supervisor reads
  // `CLAUDEMUX_CODEX_REGISTRY_ROOT` through `codexRegistryRoot()` on
  // every call.
  savedRegistryRoot = process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = suffixDir
  let counter = 0
  nameUnder = () => `c-${counter++}`
  toReap = []
})

afterEach(async () => {
  for (const name of toReap) await reapDaemon(name)
  if (savedRegistryRoot === undefined) delete process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  else process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = savedRegistryRoot
  rmSync(suffixDir, { recursive: true, force: true })
})

describe('codex-supervisor — spawn + liveness', () => {
  test('spawnDaemon brings up a daemon, binds the socket, writes the registry entry', async () => {
    const name = nameUnder()
    toReap.push(name)

    const state = await spawnDaemon({ name, binPath: FAKE_CODEX, readyTimeoutMs: 5000 })

    expect(state.name).toBe(name)
    expect(state.pid).toBeGreaterThan(0)
    expect(state.socketPath).toBe(codexSocketPath(name))
    expect(state.threadId).toBeNull()
    expect(state.lastSeen).toBeNull()

    expect(existsSync(codexPidFile(name))).toBe(true)
    expect(existsSync(codexSocketPath(name))).toBe(true)
    expect(statSync(codexSocketPath(name)).isSocket()).toBe(true)
    expect(daemonAlive(name)).toBe(true)
  })

  test('readDaemonState reads back what spawnDaemon wrote', async () => {
    const name = nameUnder()
    toReap.push(name)
    const spawned = await spawnDaemon({ name, binPath: FAKE_CODEX, readyTimeoutMs: 5000 })

    const state = readDaemonState(name)
    expect(state).not.toBeNull()
    expect(state!.pid).toBe(spawned.pid)
    expect(state!.startedAt).toBe(spawned.startedAt)
  })

  test('readDaemonState returns null for a name with no registry entry', () => {
    expect(readDaemonState(nameUnder())).toBeNull()
  })

  test('daemonAlive is false for a name with no entry', () => {
    expect(daemonAlive(nameUnder())).toBe(false)
  })

  test('listDaemons enumerates every entry in the registry', async () => {
    const a = nameUnder()
    const b = nameUnder()
    toReap.push(a, b)
    await spawnDaemon({ name: a, binPath: FAKE_CODEX, readyTimeoutMs: 5000 })
    await spawnDaemon({ name: b, binPath: FAKE_CODEX, readyTimeoutMs: 5000 })

    const all = listDaemons()
    expect(all).toContain(a)
    expect(all).toContain(b)
  })

  test('listDaemons enumerates nested teammate names', async () => {
    const name = `codex/${nameUnder()}`
    toReap.push(name)
    await spawnDaemon({ name, binPath: FAKE_CODEX, readyTimeoutMs: 5000 })

    expect(listDaemons()).toContain(name)
  })

  test('isProcessAlive returns false for the impossible pid 0', () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
  })
})

describe('codex-supervisor — reap', () => {
  test('reapDaemon kills the process and removes the registry directory', async () => {
    const name = nameUnder()
    await spawnDaemon({ name, binPath: FAKE_CODEX, readyTimeoutMs: 5000 })
    expect(daemonAlive(name)).toBe(true)

    await reapDaemon(name)

    expect(daemonAlive(name)).toBe(false)
    expect(readDaemonState(name)).toBeNull()
    expect(existsSync(codexTeammateDir(name))).toBe(false)
  })

  test('reapDaemon on a missing name is a no-op', async () => {
    await expect(reapDaemon(nameUnder())).resolves.toBeUndefined()
  })

  test('reapDaemon removes only the requested nested-name registry', async () => {
    const parent = nameUnder()
    const child = `${parent}/child`
    toReap.push(parent, child)
    await spawnDaemon({ name: parent, binPath: FAKE_CODEX, readyTimeoutMs: 5000 })
    await spawnDaemon({ name: child, binPath: FAKE_CODEX, readyTimeoutMs: 5000 })

    await reapDaemon(parent)

    expect(readDaemonState(parent)).toBeNull()
    expect(existsSync(codexPidFile(parent))).toBe(false)
    expect(existsSync(codexSocketPath(parent))).toBe(false)
    expect(readDaemonState(child)).not.toBeNull()
    expect(daemonAlive(child)).toBe(true)
    expect(existsSync(codexTeammateDir(child))).toBe(true)
  })

  test('reapDaemon tears down a stale entry whose process has already died', async () => {
    const name = nameUnder()
    const state = await spawnDaemon({ name, binPath: FAKE_CODEX, readyTimeoutMs: 5000 })
    // Kill the process out from under the registry, leaving the entry
    // pointing at a dead pid — what an OS reboot or crash would leave.
    process.kill(state.pid, 'SIGKILL')
    // Wait briefly for the OS to reap.
    await new Promise((res) => setTimeout(res, 100))
    expect(daemonAlive(name)).toBe(false)
    // Reap should still tear down the directory.
    await reapDaemon(name)
    expect(existsSync(codexTeammateDir(name))).toBe(false)
  })

  test('reapDaemon group-kills a child that survived a SIGKILL of the leader', async () => {
    // The real codex CLI is a node wrapper that spawns a rust child in
    // the same process group. A historical leader-only kill orphaned
    // the child; the dispatcher hit 11 of those during stage 4
    // dogfooding. This test fixes that mode at the supervisor layer:
    // ask the fake to spawn a same-group child, SIGKILL only the
    // leader (mimicking an external `kill -9` or a wrapper crash),
    // then call reapDaemon and assert the in-group child is gone too.
    const name = nameUnder()
    const state = await spawnDaemon({
      name,
      binPath: FAKE_CODEX,
      readyTimeoutMs: 5000,
      env: { ...process.env, CODEX_FAKE_SPAWN_CHILD: '1' },
    })
    // Poll for the fake's child to appear in the group. A fixed sleep
    // would flake on a slow CI runner where the spawn round-trip
    // occasionally takes longer than the wait; polling stays cheap on
    // the common path and only stretches when needed.
    const childrenBefore = await pollFor(
      () => pgidMembers(state.pid),
      (members) => members.length >= 2,
      3000,
    )
    expect(childrenBefore.length).toBeGreaterThanOrEqual(2)
    expect(childrenBefore).toContain(state.pid)

    // SIGKILL only the leader. This is the failure mode the historical
    // single-pid `process.kill(state.pid, 'SIGKILL')` would have stopped at.
    process.kill(state.pid, 'SIGKILL')
    await new Promise((res) => setTimeout(res, 150))
    expect(isProcessAlive(state.pid)).toBe(false)
    const childrenAfterCrash = await pgidMembers(state.pid)
    // The leader is gone but a same-group child should still be running.
    expect(childrenAfterCrash.length).toBeGreaterThanOrEqual(1)

    // The fix: reapDaemon walks the process group, not just the leader.
    await reapDaemon(name)
    await new Promise((res) => setTimeout(res, 150))
    const childrenAfterReap = await pgidMembers(state.pid)
    expect(childrenAfterReap).toEqual([])
    expect(existsSync(codexTeammateDir(name))).toBe(false)
  })
})

describe('codex-supervisor — failure paths', () => {
  test('stale cleanup before parent spawn preserves an existing nested child registry', async () => {
    const parent = nameUnder()
    const child = `${parent}/child`
    toReap.push(parent, child)
    await spawnDaemon({ name: child, binPath: FAKE_CODEX, readyTimeoutMs: 5000 })

    await spawnDaemon({ name: parent, binPath: FAKE_CODEX, readyTimeoutMs: 5000 })

    expect(readDaemonState(parent)).not.toBeNull()
    expect(daemonAlive(parent)).toBe(true)
    expect(readDaemonState(child)).not.toBeNull()
    expect(daemonAlive(child)).toBe(true)
  })

  test('spawnDaemon rejects when the binary exits before binding the socket', async () => {
    const name = nameUnder()
    toReap.push(name)
    await expect(
      spawnDaemon({
        name,
        binPath: FAKE_CODEX,
        env: { ...process.env, CODEX_FAKE_EXIT_BEFORE_BIND: '1' },
        readyTimeoutMs: 3000,
      }),
    ).rejects.toThrow(/exited before binding|did not bind/)
    // Registry entry is torn back down on failure — a half-spawned
    // daemon is worse than none.
    expect(readDaemonState(name)).toBeNull()
    expect(existsSync(codexTeammateDir(name))).toBe(false)
  })

  test('spawnDaemon rejects when the binary never binds within the deadline', async () => {
    const name = nameUnder()
    toReap.push(name)
    // Tell the fake to delay binding longer than the readyTimeout so the
    // probe times out while the process is still alive.
    await expect(
      spawnDaemon({
        name,
        binPath: FAKE_CODEX,
        env: { ...process.env, CODEX_FAKE_BIND_DELAY_MS: '5000' },
        readyTimeoutMs: 500,
      }),
    ).rejects.toThrow(/did not bind/)
    expect(readDaemonState(name)).toBeNull()
  })

  test('spawnDaemon rejects when the binary path does not exist', async () => {
    const name = nameUnder()
    toReap.push(name)
    await expect(
      spawnDaemon({
        name,
        binPath: '/nonexistent/codex',
        readyTimeoutMs: 1000,
      }),
    ).rejects.toThrow(/exited before binding|did not bind|failed to spawn|ENOENT/)
    expect(readDaemonState(name)).toBeNull()
  })

  test('spawnDaemon refuses to spawn over an already-alive daemon of the same name', async () => {
    const name = nameUnder()
    toReap.push(name)
    await spawnDaemon({ name, binPath: FAKE_CODEX, readyTimeoutMs: 5000 })
    await expect(
      spawnDaemon({ name, binPath: FAKE_CODEX, readyTimeoutMs: 5000 }),
    ).rejects.toThrow(/already alive/)
  })
})
