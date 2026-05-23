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

import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import {
  codexAsk,
  codexKill,
  codexSend,
  codexSpawn,
  codexWait,
  isCodexTarget,
  subscribeTurnCollection,
} from '../src/engines/codex/verbs'
import type { CodexWsClient } from '../src/engines/codex/rpc'
import type {
  NotificationHandler,
  ServerRequestHandler,
} from '../src/engines/codex/rpc'
import { reapDaemon } from '../src/engines/codex/supervisor'
import {
  CodexTeammateRecord,
  codexPidFile,
  codexStartedAtFile,
  codexTeammateDir,
  removeBaseRecord,
  writeBaseRecord,
} from '../src/engines/codex/persistence'

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
    expect(isCodexTarget('codex/foo')).toBe(true)
  })

  test('any other repo name stays on the tmux driver', () => {
    expect(isCodexTarget('my-repo')).toBe(false)
    expect(isCodexTarget('codex')).toBe(false)
    expect(isCodexTarget('Codex-1')).toBe(false)
    expect(isCodexTarget('')).toBe(false)
  })

  test('a stale daemon registry does not define codex identity', () => {
    const name = `plain-stale-${Date.now()}`
    mkdirSync(codexTeammateDir(name), { recursive: true })
    writeFileSync(codexPidFile(name), `${process.pid}\n`)
    writeFileSync(codexStartedAtFile(name), `${Math.floor(Date.now() / 1000)}\n`)

    expect(isCodexTarget(name)).toBe(false)
  })

  test('a base record with engine=codex defines codex identity', () => {
    const name = `plain-record-${Date.now()}`
    writeBaseRecord(new CodexTeammateRecord({
      name,
      cwd: '/tmp',
      createdAt: 1,
      displayName: null,
    }))
    try {
      expect(isCodexTarget(name)).toBe(true)
    } finally {
      removeBaseRecord(name)
    }
  })
})

describe('codexKill — idempotency and message shape', () => {
  test('killing a non-existent teammate is a no-op with a clear message', async () => {
    const name = `codex-missing-${Date.now()}`
    removeBaseRecord(name)
    const result = await codexKill(name)
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

  test('killing a base-record-only codex teammate reports a successful kill', async () => {
    const name = nameUnder()
    writeBaseRecord(new CodexTeammateRecord({
      name,
      cwd: '/tmp',
      createdAt: 1,
      displayName: null,
    }))
    try {
      const killed = await codexKill(name)
      expect(killed).toEqual({ code: 0, stdout: '', stderr: `killed: ${name}\n` })
    } finally {
      removeBaseRecord(name)
    }
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
    // The contention check fires before the protocol round-trip — it should
    // fail at "all busy" without ever opening the websocket.
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

/**
 * `subscribeTurnCollection` is the seam that fixes the empty-items bug the
 * codex driver shipped with — every `turn/completed` envelope comes back with
 * `items: []` / `itemsView: "notLoaded"`, and the real items only arrive on
 * the parallel `item/completed` stream. The collector subscribes to both and
 * resolves a merged Turn.
 *
 * These tests pin the collector against the protocol contract directly: a
 * fake notification source (a stand-in for `CodexWsClient`) replays the
 * exact sequence the daemon emits, and the collector's resolved Turn is
 * checked field by field.
 */
describe('subscribeTurnCollection — turn/item stream merge', () => {
  function makeFakeClient(): {
    client: CodexWsClient
    emit: NotificationHandler
  } {
    const handlers: NotificationHandler[] = []
    const fake = {
      onNotification(handler: NotificationHandler): void {
        handlers.push(handler)
      },
      // The collector never touches these; the casts below keep the
      // signature compatible with the real `CodexWsClient` interface.
      setServerRequestHandler(_h: ServerRequestHandler): void {},
      ready(): Promise<void> {
        return Promise.resolve()
      },
      request<R = unknown>(): Promise<R> {
        throw new Error('not used by the collector')
      },
      close(): void {},
    }
    const emit: NotificationHandler = (notif) => {
      for (const h of handlers) h(notif)
    }
    return { client: fake as unknown as CodexWsClient, emit }
  }

  test('items emitted before turn/completed are merged into the resolved Turn', async () => {
    const { client, emit } = makeFakeClient()
    const collector = subscribeTurnCollection(client, 'thread-1')

    // Daemon protocol: each ItemCompleted is sent on the wire BEFORE the
    // matching TurnCompleted, in the same mpsc channel. Replay that order.
    emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-A',
        completedAtMs: 1,
        item: { type: 'agentMessage', id: 'm1', text: 'hi', phase: null, memoryCitation: null },
      },
    } as never)
    emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-A',
        completedAtMs: 2,
        item: { type: 'reasoning', id: 'r1', summary: ['s'], content: ['c'] },
      },
    } as never)
    emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-A',
          items: [],
          itemsView: 'notLoaded',
          status: 'completed',
          error: null,
          startedAt: 100,
          completedAt: 101,
          durationMs: 1000,
        },
      },
    } as never)

    const resolved = await collector.awaitTurn()
    expect(resolved.threadId).toBe('thread-1')
    expect(resolved.turn.id).toBe('turn-A')
    // The fix: items is populated from the stream, not the empty daemon husk.
    expect(resolved.turn.items.length).toBe(2)
    expect(resolved.turn.items[0]).toMatchObject({ type: 'agentMessage', text: 'hi' })
    expect(resolved.turn.items[1]).toMatchObject({ type: 'reasoning' })
    // itemsView is flipped to "full" because the client now has every item
    // the daemon emitted for this turn — not the daemon's "notLoaded" status.
    expect(resolved.turn.itemsView).toBe('full')
    // Turn metadata (timing, status, error) carries through from turn/completed.
    expect(resolved.turn.status).toBe('completed')
    expect(resolved.turn.durationMs).toBe(1000)
  })

  test('items addressed to a different thread or turn are ignored', async () => {
    const { client, emit } = makeFakeClient()
    const collector = subscribeTurnCollection(client, 'thread-1')

    // A noisy daemon (multiple concurrent threads) interleaves item events
    // across threads. The collector filters by its bound thread; cross-thread
    // items must not leak into the merged turn.
    emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-2',
        turnId: 'turn-X',
        completedAtMs: 1,
        item: { type: 'agentMessage', id: 'mX', text: 'other thread', phase: null, memoryCitation: null },
      },
    } as never)
    // An ItemCompleted whose `turnId` doesn't match the eventual
    // `turn.id` of `turn/completed` is dropped on the floor too — the
    // collector buckets by turnId and only the matching bucket folds in.
    emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-stale',
        completedAtMs: 2,
        item: { type: 'agentMessage', id: 'mStale', text: 'stale turn', phase: null, memoryCitation: null },
      },
    } as never)
    emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-1',
        turnId: 'turn-A',
        completedAtMs: 3,
        item: { type: 'agentMessage', id: 'm1', text: 'real', phase: null, memoryCitation: null },
      },
    } as never)
    emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-A',
          items: [],
          itemsView: 'notLoaded',
          status: 'completed',
          error: null,
          startedAt: 0,
          completedAt: 1,
          durationMs: 1,
        },
      },
    } as never)

    const resolved = await collector.awaitTurn()
    expect(resolved.turn.items.length).toBe(1)
    expect(resolved.turn.items[0]).toMatchObject({ id: 'm1', text: 'real' })
  })

  test('a turn/completed with no observed items resolves with itemsView "notLoaded"', async () => {
    // The wait path can subscribe after the daemon has already finished
    // emitting the turn's items (the `tm send --no-wait` window — events
    // fired to a disconnected peer and the dispatcher cannot recover
    // them). In that case the bucket stays empty, and stamping
    // `"full"` would be a lie. `"notLoaded"` is the same value the
    // daemon originally shipped — it says "the client does not have a
    // complete view of this turn", which is exactly the truth.
    const { client, emit } = makeFakeClient()
    const collector = subscribeTurnCollection(client, 'thread-1')

    emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-empty',
          items: [],
          itemsView: 'notLoaded',
          status: 'completed',
          error: null,
          startedAt: 0,
          completedAt: 1,
          durationMs: 1,
        },
      },
    } as never)

    const resolved = await collector.awaitTurn()
    expect(resolved.turn.items.length).toBe(0)
    expect(resolved.turn.itemsView).toBe('notLoaded')
  })

  test('awaitTurn() is idempotent — a second call returns the same promise', async () => {
    // The interface is exported and a future caller might naturally
    // `await` twice (or branch on whether they hold a Promise yet). The
    // collector caches the wait Promise so a second call cannot
    // orphan the first.
    const { client, emit } = makeFakeClient()
    const collector = subscribeTurnCollection(client, 'thread-1')

    const p1 = collector.awaitTurn()
    const p2 = collector.awaitTurn()
    expect(p1).toBe(p2)

    emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-A',
          items: [],
          itemsView: 'notLoaded',
          status: 'completed',
          error: null,
          startedAt: 0,
          completedAt: 0,
          durationMs: 0,
        },
      },
    } as never)

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(r2)

    // A third call after resolve returns the cached value (still the same).
    const r3 = await collector.awaitTurn()
    expect(r3).toBe(r1)
  })

  test('turn/completed addressed to a different thread does not resolve the wait', async () => {
    const { client, emit } = makeFakeClient()
    const collector = subscribeTurnCollection(client, 'thread-1')

    // A turn-completed for an unrelated thread arrives first; the
    // collector must keep waiting for its own thread's completion.
    emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-other',
        turn: {
          id: 'turn-other',
          items: [],
          itemsView: 'notLoaded',
          status: 'completed',
          error: null,
          startedAt: 0,
          completedAt: 0,
          durationMs: 0,
        },
      },
    } as never)

    let resolved = false
    void collector.awaitTurn().then(() => {
      resolved = true
    })
    // Yield once so the microtask queue drains; a buggy collector would
    // have resolved on the stranger's turn/completed.
    await new Promise((res) => setTimeout(res, 5))
    expect(resolved).toBe(false)

    // Now drive the real thread's completion and confirm resolve.
    emit({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-A',
          items: [],
          itemsView: 'notLoaded',
          status: 'completed',
          error: null,
          startedAt: 0,
          completedAt: 0,
          durationMs: 0,
        },
      },
    } as never)
    await new Promise((res) => setTimeout(res, 5))
    expect(resolved).toBe(true)
  })
})
