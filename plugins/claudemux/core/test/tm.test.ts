/**
 * The shell-out layer's contract is a faithful pass-through: the verb, the
 * argument vector, and stdin reach `tm` verbatim, and exit code / stdout /
 * stderr come back unfiltered. These tests pin that against a fake `tm`
 * (`fixtures/fake-tm`) selected through the `CLAUDEMUX_TM` override.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import { runTm } from '../src/tm'

const FAKE_TM = join(import.meta.dir, 'fixtures', 'fake-tm')
let savedOverride: string | undefined

beforeEach(() => {
  savedOverride = process.env.CLAUDEMUX_TM
  process.env.CLAUDEMUX_TM = FAKE_TM
})

afterEach(() => {
  if (savedOverride === undefined) delete process.env.CLAUDEMUX_TM
  else process.env.CLAUDEMUX_TM = savedOverride
})

describe('runTm forwards faithfully', () => {
  test('the verb and every argument reach tm in order', async () => {
    const result = await runTm('send', ['acme', '--prompt', 'hello world'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('VERB:send')
    expect(result.stdout).toContain('ARG:acme')
    expect(result.stdout).toContain('ARG:--prompt')
    expect(result.stdout).toContain('ARG:hello world')
  })

  test('stdin is piped through for a stdin-reading verb', async () => {
    const result = await runTm('archive', [], { stdin: 'task-123' })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('STDIN:task-123')
  })

  test('a verb with no stdin does not hang and reads no stdin', async () => {
    const result = await runTm('doctor', [])
    expect(result.code).toBe(0)
    expect(result.stdout).not.toContain('STDIN:')
  })

  test('stderr and a non-zero exit code are surfaced unfiltered', async () => {
    const result = await runTm('__fail__', [])
    expect(result.code).toBe(3)
    expect(result.stderr).toContain('boom')
  })

  test('stdout and stderr stay split', async () => {
    const result = await runTm('states', [])
    expect(result.stdout).toContain('VERB:states')
    expect(result.stdout).not.toContain('fake-tm: states ok')
    expect(result.stderr).toContain('fake-tm: states ok')
  })
})
