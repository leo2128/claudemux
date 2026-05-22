/**
 * The core's Phase A contract: every `tm` verb is exposed as a tool that
 * forwards faithfully to the shell-out layer, and the registry is kept in
 * step with the verbs that change the teammate set. This is the conformance
 * smoke — it drives every verb through the core against a fake `tm` and
 * asserts the verb and arguments are forwarded unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCore } from '../src/core'
import { Registry } from '../src/registry'
import type { Signal, SignalSource } from '../src/subscription'
import type { TmResult, TmRunner } from '../src/tm'
import { TM_VERBS } from '../src/verbs'

/** A fake `tm` runner that records every call and returns a canned result. */
function fakeRunner(result: Partial<TmResult> = {}): {
  run: TmRunner
  calls: { verb: string; args: readonly string[]; stdin?: string }[]
} {
  const calls: { verb: string; args: readonly string[]; stdin?: string }[] = []
  const run: TmRunner = async (verb, args, options) => {
    calls.push({ verb, args, stdin: options?.stdin })
    return { code: 0, stdout: `ran ${verb}`, stderr: '', ...result }
  }
  return { run, calls }
}

/** A fake signal source: one sid is "busy", everything else is unobserved. */
const fakeSignals: SignalSource = {
  signalFor: (sid): Signal | undefined =>
    sid === 'busy-sid' ? { busy: true, idle: false } : undefined,
}

/** Pull the first text block out of a tool result. */
function textOf(result: CallToolResult): string {
  const block = result.content[0]
  if (!block || block.type !== 'text') throw new Error('expected a text content block')
  return block.text
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudemux-core-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** A fresh registry on a temp file. */
function freshRegistry(): Registry {
  return new Registry(join(dir, 'registry.json'))
}

describe('the tool list', () => {
  test('exposes every tm verb plus the core-native teammates tool', () => {
    const core = createCore({ runTm: fakeRunner().run, registry: freshRegistry(), subscription: fakeSignals })
    const names = core.tools.map((t) => t.name)
    for (const verb of TM_VERBS) expect(names).toContain(verb.name)
    expect(names).toContain('teammates')
    expect(core.tools).toHaveLength(TM_VERBS.length + 1)
  })
})

describe('every verb forwards faithfully to tm', () => {
  for (const verb of TM_VERBS) {
    test(`${verb.name} reaches tm with its verb name and arguments`, async () => {
      const runner = fakeRunner()
      const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals })
      if (verb.registry === 'none') {
        await core.handleTool(verb.name, { args: ['alpha', '--flag', 'beta'] })
      } else {
        // A registry verb takes the repo as a structured field; the core
        // prepends it to the argument vector handed to `tm`.
        await core.handleTool(verb.name, { repo: 'alpha', args: ['--flag', 'beta'] })
      }
      expect(runner.calls).toHaveLength(1)
      expect(runner.calls[0]?.verb).toBe(verb.name)
      expect(runner.calls[0]?.args).toEqual(['alpha', '--flag', 'beta'])
    })
  }

  test('a verb with no args forwards an empty argument vector', async () => {
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals })
    await core.handleTool('doctor', {})
    expect(runner.calls[0]?.args).toEqual([])
  })

  test('stdin is forwarded to the runner', async () => {
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals })
    await core.handleTool('archive', { stdin: 'task-9' })
    expect(runner.calls[0]?.stdin).toBe('task-9')
  })
})

describe('result shaping', () => {
  test('a non-zero exit marks the result isError and surfaces both streams', async () => {
    const runner = fakeRunner({ code: 2, stdout: 'partial', stderr: 'it broke' })
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals })
    const result = await core.handleTool('send', { args: ['acme'] })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('partial')
    expect(textOf(result)).toContain('it broke')
  })

  test('an unknown tool is an error result', async () => {
    const core = createCore({ runTm: fakeRunner().run, registry: freshRegistry(), subscription: fakeSignals })
    const result = await core.handleTool('not-a-verb', {})
    expect(result.isError).toBe(true)
  })

  test('a non-string-array args argument is rejected before any shell-out', async () => {
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals })
    const result = await core.handleTool('send', { args: [1, 2] })
    expect(result.isError).toBe(true)
    expect(runner.calls).toHaveLength(0)
  })

  test('a runner that throws becomes an error result, not a rejected call', async () => {
    const runTm: TmRunner = () => Promise.reject(new Error('tm not found'))
    const core = createCore({ runTm, registry: freshRegistry(), subscription: fakeSignals })
    const result = await core.handleTool('doctor', {})
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('tm not found')
  })

  test('a code-0 verb with only stderr output is shown plainly, not as an error annex', async () => {
    // `tm spawn` succeeds (exit 0) while printing `spawned:`/`ready:` to stderr.
    const runner = fakeRunner({ code: 0, stdout: '', stderr: 'spawned: acme\n' })
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals })
    const result = await core.handleTool('states', {})
    expect(result.isError).toBe(false)
    expect(textOf(result)).toBe('spawned: acme')
    expect(textOf(result)).not.toContain('--- stderr ---')
  })

  test('both streams are kept distinguishable under a divider', async () => {
    const runner = fakeRunner({ code: 0, stdout: 'the reply', stderr: 'a diagnostic' })
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals })
    expect(textOf(await core.handleTool('states', {}))).toBe('the reply\n--- stderr ---\na diagnostic')
  })

  test('trailing newlines are trimmed and empty output reports the exit code', async () => {
    const blank = fakeRunner({ code: 0, stdout: '\n\n', stderr: '' })
    const blankCore = createCore({ runTm: blank.run, registry: freshRegistry(), subscription: fakeSignals })
    expect(textOf(await blankCore.handleTool('states', {}))).toContain('exited 0 with no output')

    const trailing = fakeRunner({ code: 0, stdout: 'line\n\n', stderr: '' })
    const trailingCore = createCore({ runTm: trailing.run, registry: freshRegistry(), subscription: fakeSignals })
    expect(textOf(await trailingCore.handleTool('states', {}))).toBe('line')
  })
})

describe('the registry tracks the mutating verbs', () => {
  test('a successful spawn records the teammate from its structured repo', async () => {
    const registry = freshRegistry()
    const core = createCore({ runTm: fakeRunner().run, registry, subscription: fakeSignals })
    await core.handleTool('spawn', { repo: '__coretest_spawn__' })
    expect(registry.get('__coretest_spawn__')?.repo).toBe('__coretest_spawn__')
  })

  test('a failed spawn records nothing', async () => {
    const registry = freshRegistry()
    const runner = fakeRunner({ code: 1, stderr: 'spawn failed' })
    const core = createCore({ runTm: runner.run, registry, subscription: fakeSignals })
    await core.handleTool('spawn', { repo: '__coretest_failed__' })
    expect(registry.get('__coretest_failed__')).toBeUndefined()
  })

  test('a successful kill removes the teammate', async () => {
    const registry = freshRegistry()
    registry.record({ repo: '__coretest_kill__', sid: null, cwd: null })
    const core = createCore({ runTm: fakeRunner().run, registry, subscription: fakeSignals })
    await core.handleTool('kill', { repo: '__coretest_kill__' })
    expect(registry.get('__coretest_kill__')).toBeUndefined()
  })

  test('resume records the teammate even when its args carry leading flags', async () => {
    // `tm resume` accepts flags before the repo; the structured `repo` field
    // means the core records the right teammate regardless of `args` order.
    const registry = freshRegistry()
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry, subscription: fakeSignals })
    await core.handleTool('resume', { repo: '__coretest_resume__', args: ['--task', 'slug'] })
    expect(registry.get('__coretest_resume__')?.repo).toBe('__coretest_resume__')
    // The repo is still passed to `tm` as the first argument.
    expect(runner.calls[0]?.args).toEqual(['__coretest_resume__', '--task', 'slug'])
  })

  test('a registry verb with no repo is rejected before any shell-out', async () => {
    const registry = freshRegistry()
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry, subscription: fakeSignals })
    const result = await core.handleTool('spawn', { args: ['--prompt', 'hi'] })
    expect(result.isError).toBe(true)
    expect(runner.calls).toHaveLength(0)
    expect(registry.list()).toEqual([])
  })
})

describe('the teammates tool', () => {
  test('lists the registry and annotates each entry with its live signal', async () => {
    const registry = freshRegistry()
    registry.record({ repo: 'busy-repo', sid: 'busy-sid', cwd: '/r/busy' })
    registry.record({ repo: 'quiet-repo', sid: 'quiet-sid', cwd: '/r/quiet' })
    const core = createCore({ runTm: fakeRunner().run, registry, subscription: fakeSignals })

    const parsed = JSON.parse(textOf(await core.handleTool('teammates', {}))) as {
      teammates: { repo: string; signal: Signal | null }[]
    }
    const byRepo = new Map(parsed.teammates.map((t) => [t.repo, t]))
    expect(byRepo.get('busy-repo')?.signal).toEqual({ busy: true, idle: false })
    expect(byRepo.get('quiet-repo')?.signal).toBeNull()
  })
})
