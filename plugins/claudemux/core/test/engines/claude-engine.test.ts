/**
 * Coverage for `ClaudeEngine` fleet-visibility methods — Phase 2a-1.
 *
 *  - `list` strips the tmux session prefix but does NOT decode `__` → `/`.
 *    Decoding here would mis-identify a flat legacy teammate `flow__1` as
 *    a nested name `flow/1` (P1 regression).
 *  - `status` propagates tmux failures rather than swallowing them into a
 *    `present` result with the pane id leaking out as stdout (P2
 *    regression).
 */

import { afterEach, describe, expect, test } from 'vitest'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'

import { ClaudeEngine } from '../../src/engines/claude/claude-engine'
import type { NativeEnv } from '../../src/env'
import {
  busyMarkerFor,
  cwdFile,
  idleDir,
  idleMarkerFor,
  lastFileFor,
  readyFile,
  sendAtFile,
  sidFile,
} from '../../src/persistence/paths'
import type { TmuxRunner, TmuxResult } from '../../src/tmux'

const noopColumn = async () => ({ code: 0, stdout: '', stderr: '' })
const noopGrep = async () => 1

function makeEnv(runTmux: TmuxRunner): NativeEnv {
  return {
    runTmux,
    runColumn: noopColumn,
    runGrep: noopGrep,
    dispatcherDir: '/tmp',
    projectsDir: '/tmp/projects',
  }
}

function tmuxOk(stdout: string, stderr = ''): TmuxResult {
  return { code: 0, stdout, stderr }
}

function tmuxFail(stderr: string, code = 1): TmuxResult {
  return { code, stdout: '', stderr }
}

describe('ClaudeEngine.list — Phase 2a-1 raw tmux session names', () => {
  test('does not decode __ → /; surfaces legacy teammate-flow__1 as flow__1', async () => {
    const env = makeEnv(async (args) => {
      if (args[0] === 'ls') {
        return tmuxOk('teammate-flow__1: 1 windows\nteammate-alpha: 1 windows\n')
      }
      return tmuxOk('')
    })
    const engine = new ClaudeEngine(env)
    const rows = await engine.list({ now: () => 0, env: {} })
    expect(rows.map((r) => r.name).sort()).toEqual(['alpha', 'flow__1'])
  })

  test('an empty tmux listing yields no rows (not a failure)', async () => {
    const env = makeEnv(async () => tmuxOk(''))
    const engine = new ClaudeEngine(env)
    expect(await engine.list({ now: () => 0, env: {} })).toEqual([])
  })

  test('a tmux throw is swallowed (list is not a hard fail path)', async () => {
    const env = makeEnv(async () => {
      throw new Error('boom')
    })
    const engine = new ClaudeEngine(env)
    expect(await engine.list({ now: () => 0, env: {} })).toEqual([])
  })
})

describe('ClaudeEngine.status — failure propagation', () => {
  test('capture-pane returning code !== 0 surfaces as kind:failed (P2 regression)', async () => {
    const env = makeEnv(async (args) => {
      if (args[0] === 'has-session') return tmuxOk('')
      if (args[0] === 'list-sessions') {
        return tmuxOk('$3 teammate-alpha\n')
      }
      if (args[0] === 'capture-pane') {
        return tmuxFail('tmux: pane gone', 1)
      }
      return tmuxOk('')
    })
    const engine = new ClaudeEngine(env)
    const result = await engine.status({ name: 'alpha', lines: 80 }, { now: () => 0, env: {} })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.message).toMatch(/pane gone|tmux capture-pane/)
    }
  })

  test('capture-pane throwing surfaces as kind:failed', async () => {
    const env = makeEnv(async (args) => {
      if (args[0] === 'has-session') return tmuxOk('')
      if (args[0] === 'list-sessions') return tmuxOk('$3 teammate-alpha\n')
      if (args[0] === 'capture-pane') throw new Error('socket vanished')
      return tmuxOk('')
    })
    const engine = new ClaudeEngine(env)
    const result = await engine.status({ name: 'alpha', lines: 80 }, { now: () => 0, env: {} })
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') {
      expect(result.message).toContain('socket vanished')
    }
  })

  test('list-sessions failure surfaces as kind:failed', async () => {
    const env = makeEnv(async (args) => {
      if (args[0] === 'has-session') return tmuxOk('')
      if (args[0] === 'list-sessions') return tmuxFail('tmux: no server', 1)
      return tmuxOk('')
    })
    const engine = new ClaudeEngine(env)
    const result = await engine.status({ name: 'alpha', lines: 80 }, { now: () => 0, env: {} })
    expect(result.kind).toBe('failed')
  })

  test('successful capture is surfaced as kind:present with the captured text as pane', async () => {
    const env = makeEnv(async (args) => {
      if (args[0] === 'has-session') return tmuxOk('')
      if (args[0] === 'list-sessions') return tmuxOk('$3 teammate-alpha\n')
      if (args[0] === 'capture-pane') return tmuxOk('hello from alpha\n')
      return tmuxOk('')
    })
    const engine = new ClaudeEngine(env)
    const result = await engine.status({ name: 'alpha', lines: 80 }, { now: () => 0, env: {} })
    expect(result.kind).toBe('present')
    if (result.kind === 'present') {
      expect(result.pane).toBe('hello from alpha\n')
      expect(result.diagnostics['tmuxSession']).toBe('teammate-alpha')
    }
  })

  test('has-session miss is not-found, no further tmux calls fire', async () => {
    const calls: string[] = []
    const env = makeEnv(async (args) => {
      calls.push(args[0] ?? '')
      if (args[0] === 'has-session') return tmuxFail('', 1)
      return tmuxOk('')
    })
    const engine = new ClaudeEngine(env)
    const result = await engine.status({ name: 'missing', lines: 80 }, { now: () => 0, env: {} })
    expect(result.kind).toBe('not-found')
    expect(calls).toEqual(['has-session'])
  })
})

describe('ClaudeEngine.kill — graceful exit via idle-marker signal', () => {
  // P0-1 (beta.10) — runGracefulExit used to wait only for `tmux
  // has-session` to report gone. On a slow box the REPL teardown
  // outran the 5+3s budget and every clean kill SIGHUP'd, leaving
  // `claude --worktree` worktrees alive. The fix watches the idle
  // marker (`/tmp/claude-idle/<sid>`) too — on-stop.sh touches it
  // when SessionEnd fires, *before* tmux reaps the pane, so an
  // observed mtime advance is the positive "session ended" signal
  // the kill path returns on.
  const name = `claudemux-kill-marker-${process.pid}-${Date.now()}`
  const sid = `kill-marker-${process.pid}-${Date.now()}`

  afterEach(() => {
    for (const file of [
      sidFile(name),
      cwdFile(name),
      sendAtFile(name),
      readyFile(name),
      idleMarkerFor(sid),
      busyMarkerFor(sid),
      lastFileFor(sid),
    ]) {
      rmSync(file, { force: true })
    }
  })

  test('marker mtime advancing mid-poll returns graceful — no SIGHUP note', async () => {
    const savedGrace = process.env['CLAUDEMUX_KILL_GRACE_MS']
    process.env['CLAUDEMUX_KILL_GRACE_MS'] = '2000'
    try {
      mkdirSync(idleDir(), { recursive: true })
      writeFileSync(sidFile(name), `${sid}\n`)
      writeFileSync(idleMarkerFor(sid), '')
      // Set baseline mtime in the past so a subsequent touch is observably newer.
      const past = new Date(Date.now() - 1000)
      utimesSync(idleMarkerFor(sid), past, past)

      let sendKeysCalls = 0
      let killSessionCalled = false
      const env = makeEnv(async (args) => {
        if (args[0] === 'has-session') return tmuxOk('')
        if (args[0] === 'send-keys') {
          sendKeysCalls++
          // First send-keys is `/exit`. Simulate `on-stop.sh` touching
          // the idle marker shortly after `SessionEnd` fires — well
          // inside the 2s budget but far enough out that the first
          // poll iteration misses, so the test exercises the
          // "marker flips between iterations" code path.
          if (sendKeysCalls === 1) {
            setTimeout(() => {
              writeFileSync(idleMarkerFor(sid), '')
            }, 100)
          }
          return tmuxOk('')
        }
        if (args[0] === 'kill-session') {
          killSessionCalled = true
          return tmuxOk('')
        }
        return tmuxOk('')
      })

      const engine = new ClaudeEngine(env)
      const result = await engine.kill({ name }, { now: () => 0, env: {} })

      expect(result.kind).toBe('killed')
      if (result.kind === 'killed') {
        // A graceful exit does not set the SIGHUP-fallback note.
        expect(result.note).toBeUndefined()
      }
      expect(killSessionCalled).toBe(false)
    } finally {
      if (savedGrace === undefined) delete process.env['CLAUDEMUX_KILL_GRACE_MS']
      else process.env['CLAUDEMUX_KILL_GRACE_MS'] = savedGrace
    }
  })

  test('marker that never advances yields the SIGHUP-fallback note with the budget rendered', async () => {
    const savedGrace = process.env['CLAUDEMUX_KILL_GRACE_MS']
    process.env['CLAUDEMUX_KILL_GRACE_MS'] = '50'
    try {
      mkdirSync(idleDir(), { recursive: true })
      writeFileSync(sidFile(name), `${sid}\n`)
      writeFileSync(idleMarkerFor(sid), '')

      let killSessionCalled = false
      const env = makeEnv(async (args) => {
        if (args[0] === 'has-session') return tmuxOk('')
        if (args[0] === 'kill-session') {
          killSessionCalled = true
          return tmuxOk('')
        }
        return tmuxOk('')
      })

      const engine = new ClaudeEngine(env)
      const result = await engine.kill({ name }, { now: () => 0, env: {} })

      expect(result.kind).toBe('killed')
      if (result.kind === 'killed') {
        expect(result.note).toMatch(/did not return SessionEnd within 50ms/)
      }
      expect(killSessionCalled).toBe(true)
    } finally {
      if (savedGrace === undefined) delete process.env['CLAUDEMUX_KILL_GRACE_MS']
      else process.env['CLAUDEMUX_KILL_GRACE_MS'] = savedGrace
    }
  })
})
