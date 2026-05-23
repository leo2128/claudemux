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
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  codexKill,
  codexSend,
  codexSpawn,
  codexWait,
  isCodexTarget,
} from '../src/codex-verbs'
import { reapDaemon } from '../src/codex-supervisor'
import { codexTeammateDir } from '../src/paths'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_CODEX = resolve(HERE, 'fixtures', 'codex-fake', 'codex')

let nameUnder: () => string
let toReap: string[]
let suffixDir: string
let savedBin: string | undefined

beforeEach(() => {
  suffixDir = mkdtempSync(join(tmpdir(), 'codex-verbs-test-'))
  const suffix = suffixDir.split('/').pop()!
  let counter = 0
  nameUnder = () => `codex-${suffix}-${counter++}`
  toReap = []
  savedBin = process.env['CLAUDEMUX_CODEX_BIN']
  process.env['CLAUDEMUX_CODEX_BIN'] = FAKE_CODEX
})

afterEach(async () => {
  for (const name of toReap) await reapDaemon(name)
  if (savedBin === undefined) delete process.env['CLAUDEMUX_CODEX_BIN']
  else process.env['CLAUDEMUX_CODEX_BIN'] = savedBin
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
