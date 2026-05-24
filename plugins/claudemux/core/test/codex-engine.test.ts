/**
 * Contract tests for `CodexEngine`.
 *
 * The fake codex binary speaks enough app-server JSON-RPC to exercise the
 * Engine interface without an OpenAI account. Supervisor-only liveness tests
 * stay in `codex-supervisor.test.ts`; this file pins the cross-engine surface
 * Phase 2b exposes to the verb layer.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { CodexEngine } from '../src/engines/codex/engine'
import { EngineRegistry } from '../src/engines/registry'
import { ProductionTeammateRouter } from '../src/identity/router'
import {
  daemonAlive,
  readDaemonState,
  reapDaemon,
} from '../src/engines/codex/supervisor'
import {
  codexBorrowLockFile,
  readBaseRecord,
  removeBaseRecord,
} from '../src/engines/codex/persistence'
import type { EngineContext } from '../src/engines/types'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_CODEX = resolve(HERE, 'fixtures', 'codex-fake', 'codex')

let registryDir: string
let identityDir: string
let cwd: string
let savedRegistryRoot: string | undefined
let savedIdentityRoot: string | undefined
let engine: CodexEngine
let spawned: string[]
let counter = 0

function ctx(): EngineContext {
  return { now: () => Date.now(), env: process.env }
}

function ctxWithEnv(env: NodeJS.ProcessEnv): EngineContext {
  return { now: () => Date.now(), env }
}

function nameUnder(): string {
  return `codex/engine-${counter++}`
}

beforeEach(() => {
  registryDir = mkdtempSync('/tmp/cmxe-')
  identityDir = mkdtempSync('/tmp/cmxe-id-')
  cwd = mkdtempSync('/tmp/cmxe-cwd-')
  savedRegistryRoot = process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  savedIdentityRoot = process.env['CLAUDEMUX_IDENTITY_ROOT']
  process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = registryDir
  process.env['CLAUDEMUX_IDENTITY_ROOT'] = identityDir
  engine = new CodexEngine({ binPath: FAKE_CODEX, readyTimeoutMs: 5000 })
  spawned = []
})

afterEach(async () => {
  for (const name of spawned) {
    await reapDaemon(name)
    removeBaseRecord(name)
  }
  if (savedRegistryRoot === undefined) delete process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  else process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = savedRegistryRoot
  if (savedIdentityRoot === undefined) delete process.env['CLAUDEMUX_IDENTITY_ROOT']
  else process.env['CLAUDEMUX_IDENTITY_ROOT'] = savedIdentityRoot
  rmSync(registryDir, { recursive: true, force: true })
  rmSync(identityDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

describe('CodexEngine — core lifecycle', () => {
  test('spawn, send, list, status, wait timeout, and kill run through the Engine API', async () => {
    const name = nameUnder()
    spawned.push(name)

    const spawn = await engine.spawn(
      {
        name,
        cwd,
        resumeCheckpoint: null,
        prompt: null,
        timeoutMs: null,
        displayName: 'engine test',
      },
      ctx(),
    )
    expect(spawn).toMatchObject({ kind: 'spawned', name })
    expect(readBaseRecord(name)).toMatchObject({
      name,
      engine: 'codex',
      cwd,
      displayName: 'engine test',
    })
    const registry = new EngineRegistry()
    registry.register(engine)
    const routed = await new ProductionTeammateRouter(registry).resolve(name)
    expect(routed).toMatchObject({ name, engine })

    const send = await engine.send(
      { name, prompt: 'pong from codex', timeoutMs: 5000, paneQuiet: false },
      ctx(),
    )
    expect(send.kind).toBe('completed')
    if (send.kind === 'completed') {
      expect(send.text).toContain('fake reply: pong from codex')
      expect(send.items).toContainEqual({ kind: 'assistant-text', text: 'fake reply: pong from codex' })
    }

    const listing = await engine.list(ctx())
    expect(listing.map((row) => row.name)).toContain(name)
    const row = listing.find((candidate) => candidate.name === name)
    expect(row?.extras).toMatchObject({
      sidShort: 'thread-1',
      busy: 'no',
      preview: expect.stringMatching(/^pid=\d+$/),
    })
    expect(row?.extras['last']).toMatch(/^\d+s$/)
    writeFileSync(codexBorrowLockFile(name), `${process.pid}\n`)
    const busyRow = (await engine.list(ctx())).find((candidate) => candidate.name === name)
    expect(busyRow).toMatchObject({ state: 'busy', extras: { busy: 'yes' } })

    const status = await engine.status({ name, lines: null }, ctx())
    expect(status).toMatchObject({ kind: 'present', name, engine: 'codex', state: 'busy', cwd })
    rmSync(codexBorrowLockFile(name), { force: true })

    const wait = await engine.wait(
      { name, recoverFor: null, timeoutMs: 10, fresh: false, paneQuiet: false },
      ctx(),
    )
    expect(wait).toMatchObject({ kind: 'timed-out' })

    const killed = await engine.kill({ name }, ctx())
    expect(killed).toEqual({ kind: 'killed' })
    expect(await engine.status({ name, lines: null }, ctx())).toEqual({ kind: 'not-found' })
  })

  test('duplicate spawn is rejected while the daemon is alive', async () => {
    const name = nameUnder()
    spawned.push(name)
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      ctx(),
    )

    const duplicate = await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      ctx(),
    )
    expect(duplicate).toEqual({ kind: 'already-exists', existingEngine: 'codex' })
  })

  test('concurrent same-name spawn keeps the winning daemon alive', async () => {
    const name = nameUnder()
    spawned.push(name)
    const slowCtx = ctxWithEnv({ ...process.env, CODEX_FAKE_BIND_DELAY_MS: '250' })

    const [first, second] = await Promise.all([
      engine.spawn(
        { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
        slowCtx,
      ),
      engine.spawn(
        { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
        slowCtx,
      ),
    ])

    const results = [first, second]
    expect(results.filter((result) => result.kind === 'spawned')).toHaveLength(1)
    const loser = results.find((result) => result.kind === 'already-exists')
    expect(loser).toEqual({ kind: 'already-exists', existingEngine: 'codex' })
    expect(daemonAlive(name)).toBe(true)
    expect(await engine.status({ name, lines: null }, ctx())).toMatchObject({
      kind: 'present',
      name,
      engine: 'codex',
    })
  })

  test('doctor reaps a crashed daemon registry entry', async () => {
    const name = nameUnder()
    spawned.push(name)
    await engine.spawn(
      { name, cwd, resumeCheckpoint: null, prompt: null, timeoutMs: null, displayName: null },
      ctx(),
    )
    const state = readDaemonState(name)
    expect(state).not.toBeNull()
    process.kill(state!.pid, 'SIGKILL')
    await new Promise((res) => setTimeout(res, 100))

    const report = await engine.doctor(ctx())
    expect(report.findings.some((finding) => finding.summary.includes(name))).toBe(true)
    expect(readDaemonState(name)).toBeNull()
    expect(readBaseRecord(name)).toBeNull()
  })
})
