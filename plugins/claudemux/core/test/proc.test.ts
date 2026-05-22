/**
 * `spawnCapture` is the one process-spawn primitive. These tests pin its
 * contract: faithful exit code and stream capture, stdin feeding, and a
 * rejection — not a resolved result — when the child cannot be spawned.
 */

import { describe, expect, test } from 'vitest'

import { spawnCapture } from '../src/proc'

describe('spawnCapture', () => {
  test('captures stdout and a zero exit code', async () => {
    const result = await spawnCapture(['echo', 'hello'])
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('hello\n')
    expect(result.stderr).toBe('')
  })

  test('surfaces a non-zero exit code as a resolved result', async () => {
    const result = await spawnCapture(['sh', '-c', 'exit 4'])
    expect(result.code).toBe(4)
  })

  test('captures stderr separately from stdout', async () => {
    const result = await spawnCapture(['sh', '-c', 'echo out; echo err >&2; exit 1'])
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('out\n')
    expect(result.stderr).toBe('err\n')
  })

  test('feeds stdin to the child', async () => {
    const result = await spawnCapture(['cat'], { stdin: 'piped-in payload' })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('piped-in payload')
  })

  test('applies an env override', async () => {
    const result = await spawnCapture(['sh', '-c', 'printf %s "$CLAUDEMUX_PROC_TEST"'], {
      env: { ...process.env, CLAUDEMUX_PROC_TEST: 'env-value' },
    })
    expect(result.stdout).toBe('env-value')
  })

  test('rejects when the binary cannot be spawned', async () => {
    await expect(spawnCapture(['/nonexistent/claudemux-no-such-binary'])).rejects.toThrow()
  })

  test('rejects an empty argument vector', async () => {
    await expect(spawnCapture([])).rejects.toThrow('empty argument vector')
  })
})
