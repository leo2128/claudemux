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

import { describe, expect, test } from 'vitest'

import { ClaudeEngine } from '../../src/engines/claude/claude-engine'
import type { NativeEnv } from '../../src/native'
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
