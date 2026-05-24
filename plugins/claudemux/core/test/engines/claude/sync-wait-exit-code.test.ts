/**
 * Sync-wait-expired exit code (124) — the contract that lets the dispatcher
 * tell "the teammate is still running, just slow" apart from "the teammate
 * is dead, respawn". Before the split both produced exit 1, which made
 * `tm spawn --prompt` look like a spawn failure on a long first turn and
 * burned the dispatcher into respawn-and-collide cycles.
 *
 * These tests pin three load-bearing properties:
 *  - The exit code on a sync-wait expiry is 124 (GNU `timeout(1)`
 *    convention, picked so existing scripts that already branch on 124 for
 *    `timeout` see the same shape on `tm`).
 *  - The stderr message says "sync wait expired" + "still running" + the
 *    suggested follow-up verb — wording the dispatcher relies on as a
 *    sanity check before re-running `tm wait`.
 *  - True failures (no tmux session, no sid marker) keep exit 1 — the
 *    sync-wait split must not paint over a genuine "the teammate is gone"
 *    signal.
 *
 * The Claude paths are exercised against real /tmp files (the production
 * code reads `/tmp/teammate-<name>.sid` and `/tmp/claude-idle/<sid>` from
 * `process.env.TMPDIR`-anchored locations); a fresh teammate name per
 * test isolates them. The codex / format-layer paths are exercised
 * directly through `formatTurn` since that verb-layer formatter is the
 * single place codex sync-wait results become a TmResult.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { claudeSend } from '../../../src/engines/claude/send'
import { claudeWait } from '../../../src/engines/claude/wait'
import { claudeCompact } from '../../../src/engines/claude/compact'
import { claudeSpawn } from '../../../src/engines/claude/spawn'
import { probeStillAlive } from '../../../src/engines/claude/wait-signals'
import {
  idleDir,
  idleMarkerFor,
  lastFileFor,
  sidFile,
} from '../../../src/engines/claude/persistence'
import { formatResume, formatTurn } from '../../../src/verbs/format'
import { EXIT_SYNC_WAIT_EXPIRED } from '../../../src/tm'
import type { ClaudeVerbEnv } from '../../../src/engines/claude/env'
import type { TmuxRunner } from '../../../src/tmux'

/**
 * A tmux runner that pretends every teammate's session is alive, every pane
 * resolves to `$0`, and every key-send succeeds. The session-name passed to
 * `list-sessions` must echo back EXACTLY what `resolvePaneTarget` is searching
 * for — claudeSend's pre-wait `sendKeys` calls `list-sessions` and dies with
 * exit 1 (no pane target) if the listing doesn't carry the teammate's tmux
 * session name verbatim. The closure rebuilds the listing per `claudeName`
 * so each test gets its own session row.
 */
function fakeTmuxAlive(claudeName: string): TmuxRunner {
  const sessionName = `teammate-${claudeName}`
  return async (args) => {
    const verb = args[0]
    if (verb === 'has-session') return { code: 0, stdout: '', stderr: '' }
    if (verb === 'list-sessions') {
      return { code: 0, stdout: `$0 ${sessionName}\n`, stderr: '' }
    }
    if (verb === 'capture-pane') return { code: 0, stdout: '', stderr: '' }
    if (verb === 'send-keys') return { code: 0, stdout: '', stderr: '' }
    if (verb === 'load-buffer') return { code: 0, stdout: '', stderr: '' }
    if (verb === 'paste-buffer') return { code: 0, stdout: '', stderr: '' }
    if (verb === 'delete-buffer') return { code: 0, stdout: '', stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }
}

/** A stateful tmux runner that switches `has-session` from alive to dead after `aliveCalls` invocations. */
function fakeTmuxDiesAfter(claudeName: string, aliveCalls: number): {
  runTmux: TmuxRunner
  hasSessionCalls: () => number
} {
  const sessionName = `teammate-${claudeName}`
  let hasSession = 0
  const runTmux: TmuxRunner = async (args) => {
    const verb = args[0]
    if (verb === 'has-session') {
      hasSession += 1
      return hasSession <= aliveCalls
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 1, stdout: '', stderr: '' }
    }
    if (verb === 'list-sessions') {
      // Listing keeps echoing the session so `resolvePaneTarget` can
      // succeed during the alive phase; the kill is observed only by
      // `has-session` which is what `requireSession` calls.
      return { code: 0, stdout: `$0 ${sessionName}\n`, stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  return { runTmux, hasSessionCalls: () => hasSession }
}

function fakeEnv(claudeName: string): ClaudeVerbEnv {
  return {
    runTmux: fakeTmuxAlive(claudeName),
    runColumn: async () => ({ code: 0, stdout: '', stderr: '' }),
    dispatcherDir: tmpdir(),
    projectsDir: tmpdir(),
  }
}

/** Every name a test below uses gets remembered so we can scrub its /tmp markers. */
const createdNames: string[] = []
const createdSids: string[] = []

function uniqueName(label: string): string {
  const name = `cmxtest-${label}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  createdNames.push(name)
  return name
}

function seedTeammateSid(name: string): string {
  const sid = `00000000-0000-4000-8000-${Math.floor(Math.random() * 1e12)
    .toString(16)
    .padStart(12, '0')
    .slice(-12)}`
  mkdirSync(idleDir(), { recursive: true })
  writeFileSync(sidFile(name), `${sid}\n`)
  createdSids.push(sid)
  return sid
}

beforeEach(() => {
  createdNames.length = 0
  createdSids.length = 0
})

afterEach(() => {
  for (const name of createdNames) {
    rmSync(sidFile(name), { force: true })
  }
  for (const sid of createdSids) {
    rmSync(idleMarkerFor(sid), { force: true })
    rmSync(lastFileFor(sid), { force: true })
  }
})

describe('Claude sync-wait expiry exits with EXIT_SYNC_WAIT_EXPIRED', () => {
  test('tm wait: --timeout 0 + no idle marker → exit 124, stderr names the follow-up verb', async () => {
    const name = uniqueName('wait')
    seedTeammateSid(name)

    const result = await claudeWait([name, '--timeout', '0'], fakeEnv(name))

    expect(result.code).toBe(EXIT_SYNC_WAIT_EXPIRED)
    expect(result.stderr).toContain('sync wait expired')
    expect(result.stderr).toContain('still running')
    expect(result.stderr).toContain(`tm wait ${name}`)
    expect(result.stderr).toContain(`exit ${EXIT_SYNC_WAIT_EXPIRED}`)
  })

  test('tm send: --timeout 0 + no idle marker → exit 124, stderr points at tm wait', async () => {
    const name = uniqueName('send')
    seedTeammateSid(name)

    const result = await claudeSend(
      [name, '--prompt', 'hi', '--timeout', '0'],
      fakeEnv(name),
    )

    expect(result.code).toBe(EXIT_SYNC_WAIT_EXPIRED)
    expect(result.stderr).toContain('tm send: sync wait expired')
    expect(result.stderr).toContain('still running')
    // The recovery hint must be `tm wait` (NOT `tm send` again — that would
    // post a second prompt and double-drive the teammate).
    expect(result.stderr).toContain(`tm wait ${name}`)
    expect(result.stderr).not.toMatch(/Re-run\s+'tm send/)
  })

  test('tm compact: --timeout 0 + no PostCompact marker → exit 124 (NOT exit 1)', async () => {
    const name = uniqueName('compact')
    seedTeammateSid(name)

    const result = await claudeCompact([name, '--timeout', '0'], fakeEnv(name))

    expect(result.code).toBe(EXIT_SYNC_WAIT_EXPIRED)
    expect(result.stderr).toContain('sync wait expired')
    expect(result.stderr).toContain('PostCompact never fired')
  })
})

describe('true failures stay at exit 1 (no sync-wait splash damage)', () => {
  test('tm send: missing sid marker keeps exit 1', async () => {
    // No seedTeammateSid call — the verb should bail with "no sid" before
    // ever entering the wait loop, and that error must stay exit 1 (a real
    // "teammate is gone" failure, not a sync-wait expiry).
    const name = uniqueName('send-no-sid')

    const result = await claudeSend(
      [name, '--prompt', 'hi', '--timeout', '0'],
      fakeEnv(name),
    )

    expect(result.code).toBe(1)
    expect(result.stderr).not.toContain('sync wait expired')
  })
})

describe('P1-2: wait-expiry re-probes liveness and returns exit 1 on a dead teammate', () => {
  test('probeStillAlive returns null when the tmux session and sid are both present', async () => {
    const name = uniqueName('probe-alive')
    seedTeammateSid(name)

    const result = await probeStillAlive(name, fakeTmuxAlive(name))

    expect(result).toBeNull()
  })

  test('probeStillAlive returns exit 1 when the tmux session vanished', async () => {
    const name = uniqueName('probe-no-session')
    seedTeammateSid(name)
    const tmux: TmuxRunner = async () => ({ code: 1, stdout: '', stderr: '' })

    const result = await probeStillAlive(name, tmux)

    expect(result).not.toBeNull()
    expect(result!.code).toBe(1)
    expect(result!.stderr).toContain('died during the wait')
    expect(result!.stderr).toContain('tmux session is gone')
  })

  test('probeStillAlive returns exit 1 when the sid file vanished', async () => {
    const name = uniqueName('probe-no-sid')
    // No `seedTeammateSid` — the sid file is absent from the start.
    const tmux: TmuxRunner = async () => ({ code: 0, stdout: '', stderr: '' })

    const result = await probeStillAlive(name, tmux)

    expect(result).not.toBeNull()
    expect(result!.code).toBe(1)
    expect(result!.stderr).toContain('sid marker disappeared')
  })

  test('tm wait: session alive at entry, dead at timeout → exit 1 (NOT 124 "still running")', async () => {
    // Reproduce the exact bug the reviewer flagged: tmux session is up when
    // `waitIdleSignal` enters (so the wait runs), but `tm kill` /  a crash
    // takes it down before the loop's deadline. Without the re-probe the
    // verb would report 124 ("still running") and the dispatcher's bg
    // classifier would happily keep tailing a corpse forever.
    const name = uniqueName('wait-dies-midflight')
    seedTeammateSid(name)
    // `claudeWait` → `waitIdleSignal` calls `requireSession` once before
    // entering the loop (call 1, alive). The probe after the loop calls it
    // again (call 2 — we want this DEAD). Allow only the first call.
    const { runTmux, hasSessionCalls } = fakeTmuxDiesAfter(name, 1)
    const env: ClaudeVerbEnv = {
      runTmux,
      runColumn: async () => ({ code: 0, stdout: '', stderr: '' }),
      dispatcherDir: tmpdir(),
      projectsDir: tmpdir(),
    }

    const result = await claudeWait([name, '--timeout', '0'], env)

    expect(result.code).toBe(1)
    expect(result.code).not.toBe(EXIT_SYNC_WAIT_EXPIRED)
    expect(result.stderr).toContain('died during the wait')
    expect(result.stderr).not.toContain('still running')
    // Sanity: the probe MUST have been the second has-session call (the
    // first is `waitIdleSignal`'s entry check). If we only see one, the
    // probe got skipped and the verb is back to the buggy 124 path.
    expect(hasSessionCalls()).toBeGreaterThanOrEqual(2)
  })

  test('tm compact: session vanished mid-wait → exit 1 not 124', async () => {
    const name = uniqueName('compact-dies-midflight')
    seedTeammateSid(name)
    // compact's pre-wait calls hit `has-session` twice (requireSession +
    // sendKeys' requireSession). The post-loop probe is the 3rd call.
    const { runTmux } = fakeTmuxDiesAfter(name, 2)
    const env: ClaudeVerbEnv = {
      runTmux,
      runColumn: async () => ({ code: 0, stdout: '', stderr: '' }),
      dispatcherDir: tmpdir(),
      projectsDir: tmpdir(),
    }

    const result = await claudeCompact([name, '--timeout', '0'], env)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('died during the wait')
  })
})

describe('P1-1: tm spawn --prompt propagates --timeout into the inner tm send', () => {
  test('--timeout reaches the inner claudeSend so the bg classifier sees 124 within the configured window', async () => {
    // Pre-existing-session + --prompt is the spawn path that rejects with
    // "already exists, atomic bootstrap rejected" — but BEFORE the
    // propagation fix that rejection happens at the spawn arg-validation
    // step. We can't easily drive the full Claude launch in a unit test
    // (it shells out to `claude` and tmux). Instead, exercise the chain
    // through `claudeSpawn` parsing: if `--timeout` were not threaded
    // through, the `SpawnArgs.timeout` field would still be `null`.
    // Round-trip through `parseSpawnArgs` directly.
    //
    // The runtime contract is verified by the type — `ClaudeLaunchArgs`
    // now carries `readonly timeout: string | null` and `claudeLaunch`
    // appends it to `sendArgs` (see spawn.ts). A future regression where
    // `claudeContinue` or `claudeSpawn` drops the field would fail
    // typecheck; this test is the runtime sanity check that the parser
    // accepts the flag end-to-end.
    const { parseSpawnArgs } = await import('../../../src/engines/claude/spawn')
    const result = parseSpawnArgs(['--prompt', 'hi', '--timeout', '7'])
    expect('error' in result).toBe(false)
    if ('error' in result) throw new Error('unexpected')
    expect(result.timeout).toBe('7')
    expect(result.hasPrompt).toBe(true)
  })
})

describe('codex (and any future engine going through formatTurn) gets the same code', () => {
  test('formatTurn maps {kind: "timed-out"} to exit 124 with sync-wait-expired wording', () => {
    const result = formatTurn({ kind: 'timed-out', elapsedMs: 1234 })

    expect(result.code).toBe(EXIT_SYNC_WAIT_EXPIRED)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('sync wait expired after 1234ms')
    expect(result.stderr).toContain('still running')
    expect(result.stderr).toContain(`exit ${EXIT_SYNC_WAIT_EXPIRED}`)
  })

  test('formatTurn keeps {kind: "failed"} on exit 1 (true failures unchanged)', () => {
    const result = formatTurn({ kind: 'failed', message: 'boom', recoverable: false })
    expect(result.code).toBe(1)
  })

  test('formatResume pipes a tmResult through verbatim — the resume → spawn → send chain stays 124', () => {
    // `tm resume --prompt` delegates the wait to `claudeSpawn` → `claudeSend`,
    // and `ClaudeEngine.resume` wraps the resulting non-zero TmResult as
    // `{kind: 'failed', tmResult: result}`. The contract that `formatResume`
    // returns `tmResult` verbatim is what keeps the 124 code visible at the
    // CLI surface; if a future refactor drops that shortcut, this test
    // catches the regression before it papers over the spurious-error fix.
    const tmResult = {
      code: EXIT_SYNC_WAIT_EXPIRED,
      stdout: '',
      stderr: 'tm send: sync wait expired …\n',
    }
    const result = formatResume({
      kind: 'failed',
      message: 'sync wait expired',
      tmResult,
    })
    expect(result).toBe(tmResult)
  })
})
