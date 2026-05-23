/**
 * Unit tests for the codex-teammate verbs.
 *
 * The verbs that drive a real codex daemon (`codexSend`, `codexWait`) need
 * a working `codex app-server` and an OpenAI account to do anything useful
 * — those paths land in the live integration suite (#36). What this file
 * pins is the cheap stuff: the target detector, the not-alive guards, the
 * kill idempotency, and a spawn/kill round-trip against the fake codex
 * binary.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  codexAsk,
  codexKill,
  codexSend,
  codexSpawn,
  codexWait,
  isCodexTarget,
} from '../src/codex-verbs'
import { reapDaemon } from '../src/codex-supervisor'
import { codexTeammateDir } from '../src/paths'
import { closeSync, openSync, writeSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_CODEX = resolve(HERE, 'fixtures', 'codex-fake', 'codex')

let nameUnder: () => string
let toReap: string[]
let suffixDir: string
let savedBin: string | undefined
let savedRegistryRoot: string | undefined

beforeEach(() => {
  // The unix socket nodes the fake daemon binds live under
  // `<registryRoot>/<name>/socket`. macOS caps unix-socket paths at
  // ~104 chars, so the registry root must stay short — keep it under
  // `/tmp` rather than `$TMPDIR` (which is a deep `/var/folders/...`
  // path on macOS).
  suffixDir = mkdtempSync('/tmp/cmxv-')
  // Private registry root + private bin path per-test so parallel test
  // files never share `/tmp/teammate-codex/` state.
  savedRegistryRoot = process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = suffixDir
  let counter = 0
  // The `codex-` prefix is part of the codex teammate contract — keep
  // it so the verb-side messages ("tm spawn codex-…") match what a
  // production caller would see.
  nameUnder = () => `codex-${counter++}`
  toReap = []
  savedBin = process.env['CLAUDEMUX_CODEX_BIN']
  process.env['CLAUDEMUX_CODEX_BIN'] = FAKE_CODEX
})

afterEach(async () => {
  for (const name of toReap) await reapDaemon(name)
  if (savedBin === undefined) delete process.env['CLAUDEMUX_CODEX_BIN']
  else process.env['CLAUDEMUX_CODEX_BIN'] = savedBin
  if (savedRegistryRoot === undefined) delete process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  else process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = savedRegistryRoot
  rmSync(suffixDir, { recursive: true, force: true })
})

describe('isCodexTarget — verb-fork prefix detection', () => {
  test('a `codex-` prefix routes to the codex driver', () => {
    expect(isCodexTarget('codex-1')).toBe(true)
    expect(isCodexTarget('codex-reviewer')).toBe(true)
    expect(isCodexTarget('codex-')).toBe(true)
  })

  test('any other repo name stays on the tmux driver', () => {
    expect(isCodexTarget('my-repo')).toBe(false)
    expect(isCodexTarget('codex')).toBe(false)
    expect(isCodexTarget('Codex-1')).toBe(false)
    expect(isCodexTarget('')).toBe(false)
  })
})

describe('codexKill — idempotency and message shape', () => {
  test('killing a non-existent teammate is a no-op with a clear message', async () => {
    const result = await codexKill(nameUnder())
    expect(result.code).toBe(0)
    expect(result.stderr).toMatch(/no codex teammate '.*' to kill \(already gone\)/)
    expect(result.stdout).toBe('')
  })

  test('a spawn → kill round-trip reports the original pid in the kill message', async () => {
    const name = nameUnder()
    const spawned = await codexSpawn(name)
    expect(spawned.code).toBe(0)
    expect(spawned.stderr).toMatch(/^spawned: .* \(pid=\d+, socket=.*\)\n$/)

    const killed = await codexKill(name)
    expect(killed.code).toBe(0)
    expect(killed.stderr).toMatch(/^killed: .* \(was pid=\d+\)\n$/)
    expect(existsSync(codexTeammateDir(name))).toBe(false)
  })
})

describe('codex verbs — daemon-not-alive guards', () => {
  test('codexSend rejects with a hint to spawn first when the daemon is gone', async () => {
    const result = await codexSend(nameUnder(), 'hello')
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/is not alive — try 'tm spawn codex-/)
  })

  test('codexWait rejects when the daemon is gone', async () => {
    const result = await codexWait(nameUnder())
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/is not alive/)
  })

  test('codexSend rejects an empty prompt with a usage line', async () => {
    const name = nameUnder()
    toReap.push(name)
    await codexSpawn(name)
    const result = await codexSend(name, '')
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/usage: tm send <teammate> "<prompt>"/)
  })
})

describe('codex verbs — spawn failure shape', () => {
  test('a failure inside spawnDaemon surfaces as a `tm: <message>` stderr line', async () => {
    process.env['CLAUDEMUX_CODEX_BIN'] = '/nonexistent/codex-bin'
    const result = await codexSpawn(nameUnder())
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/^tm: codex daemon '/)
  })
})

describe('codexAsk — pool borrow semantics', () => {
  test('rejects an empty prompt with a usage line', async () => {
    const result = await codexAsk('')
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/usage: tm ask "<prompt>"/)
  })

  test('errors when no codex teammates have been spawned', async () => {
    const result = await codexAsk('hello?')
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/no codex teammates available/)
  })

  test('reports "all busy" when every alive teammate is already borrowed', async () => {
    // Spawn one teammate, hold its borrow lock from this test, then ask.
    // The fake daemon does not speak the protocol, but ask's contention
    // check fires before the protocol round-trip — it should fail at
    // "all busy" without ever opening the websocket.
    const name = nameUnder()
    toReap.push(name)
    await codexSpawn(name)

    // Manually take the borrow lock, simulating a concurrent caller.
    const lockPath = `${codexTeammateDir(name)}/lock`
    const fd = openSync(lockPath, 'wx', 0o600)
    writeSync(fd, '99999\n')
    closeSync(fd)

    const result = await codexAsk('anyone?')
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/all 1 alive codex teammate\(s\) are busy/)
  })

  test('skips dead teammates and reports "all dead" when no live one exists', async () => {
    const name = nameUnder()
    toReap.push(name)
    const state = await codexSpawn(name)
    // Kill the daemon process so the entry stays but `daemonAlive` reads false.
    const match = /pid=(\d+)/.exec(state.stderr)
    expect(match).not.toBeNull()
    const pid = Number.parseInt(match![1] ?? '0', 10)
    process.kill(pid, 'SIGKILL')
    await new Promise((res) => setTimeout(res, 100))

    const result = await codexAsk('hi?')
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/all 1 codex teammate\(s\) are dead/)
  })
})
