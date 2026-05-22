/**
 * The core's dispatch contract: every `tm` verb is exposed as a tool, a
 * not-yet-migrated verb forwards faithfully to the `tm` shell-out, a migrated
 * verb runs natively instead, and the registry is kept in step with the verbs
 * that change the teammate set. The native-vs-`tm` *behavior* match is pinned
 * separately by `conformance.test.ts`; this file tests the core's wiring.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCore } from '../src/core'
import { isNativeVerb, triggersTmHelp } from '../src/native'
import { Registry } from '../src/registry'
import type { Signal, SignalSource } from '../src/subscription'
import type { TmResult, TmRunner } from '../src/tm'
import type { TmuxRunner } from '../src/tmux'
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

/** A quiet fake `tmux` runner — enough for `createCore`'s native-verb dep. */
const fakeTmux: TmuxRunner = async () => ({ code: 0, stdout: '', stderr: '' })

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
    const core = createCore({ runTm: fakeRunner().run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    const names = core.tools.map((t) => t.name)
    for (const verb of TM_VERBS) expect(names).toContain(verb.name)
    expect(names).toContain('teammates')
    expect(core.tools).toHaveLength(TM_VERBS.length + 1)
  })
})

describe('every not-yet-migrated verb forwards faithfully to tm', () => {
  for (const verb of TM_VERBS.filter((v) => !isNativeVerb(v.name))) {
    test(`${verb.name} reaches tm with its verb name and arguments`, async () => {
      const runner = fakeRunner()
      const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
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
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    await core.handleTool('doctor', {})
    expect(runner.calls[0]?.args).toEqual([])
  })

  test('stdin is forwarded to the runner', async () => {
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    await core.handleTool('archive', { stdin: 'task-9' })
    expect(runner.calls[0]?.stdin).toBe('task-9')
  })
})

describe('a migrated verb runs natively, not through tm', () => {
  test('ls is served from tmux, never reaching the tm shell-out', async () => {
    const runner = fakeRunner()
    const core = createCore({
      runTm: runner.run,
      registry: freshRegistry(),
      subscription: fakeSignals,
      runTmux: async () => ({ code: 0, stdout: 'teammate-x: 1 windows\n', stderr: '' }),
      dispatcherDir: '/tmp',
      projectsDir: '/tmp',
    })
    const result = await core.handleTool('ls', {})
    expect(runner.calls).toHaveLength(0)
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('teammate-x')
  })

  test('ls masks a tmux that cannot be spawned, like `tmux ls || true`', async () => {
    const runner = fakeRunner()
    const core = createCore({
      runTm: runner.run,
      registry: freshRegistry(),
      subscription: fakeSignals,
      runTmux: () => Promise.reject(new Error('tmux not found')),
      dispatcherDir: '/tmp',
      projectsDir: '/tmp',
    })
    const result = await core.handleTool('ls', {})
    expect(runner.calls).toHaveLength(0)
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('no teammate sessions')
  })

  test('last is served natively, and its repo argument reaches the handler', async () => {
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    // No marker files exist for this repo, so the native handler returns its
    // own error — whose message echoes the repo, proving the core forwarded
    // `args` to the native handler rather than the call reaching `runTm`.
    const result = await core.handleTool('last', { args: ['__coretest_argv_probe__'] })
    expect(runner.calls).toHaveLength(0)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('__coretest_argv_probe__')
  })

  test('ctx is served natively, and its repo argument reaches the handler', async () => {
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    // No sid file exists for this repo, so `ctx` soft-fails to its `?` line —
    // which echoes the repo, proving the core forwarded `args` to the native
    // handler rather than the call reaching `runTm`.
    const result = await core.handleTool('ctx', { args: ['__coretest_ctx_probe__'] })
    expect(runner.calls).toHaveLength(0)
    expect(result.isError).toBe(false)
    expect(textOf(result)).toContain('__coretest_ctx_probe__: ? (no sid file)')
  })
})

describe('a --help invocation shells out even for a migrated verb', () => {
  test('ls --help reaches tm, where the per-verb help text lives', async () => {
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    await core.handleTool('ls', { args: ['--help'] })
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.verb).toBe('ls')
    expect(runner.calls[0]?.args).toEqual(['--help'])
  })

  test('last --help reaches tm', async () => {
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    await core.handleTool('last', { args: ['--help'] })
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.args).toEqual(['--help'])
  })

  test('a --help after the repo positional does not trigger help — last still runs natively', async () => {
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    // `tm`'s pre-scan stops at the first positional, so a later `--help` is an
    // ordinary (ignored) argument — the verb runs, it does not show help.
    const result = await core.handleTool('last', { args: ['__coretest_probe__', '--help'] })
    expect(runner.calls).toHaveLength(0)
    expect(result.isError).toBe(true)
  })
})

describe("triggersTmHelp mirrors tm main's help pre-scan", () => {
  test('a -h or --help before the first positional triggers help', () => {
    expect(triggersTmHelp(['--help'])).toBe(true)
    expect(triggersTmHelp(['-h'])).toBe(true)
    expect(triggersTmHelp(['--flag', '--help'])).toBe(true)
  })

  test('the first positional stops the scan before any later --help', () => {
    expect(triggersTmHelp(['repo', '--help'])).toBe(false)
    expect(triggersTmHelp(['repo'])).toBe(false)
  })

  test('a --prompt value stops the scan', () => {
    expect(triggersTmHelp(['--prompt', '--help'])).toBe(false)
    expect(triggersTmHelp(['--prompt=x', '--help'])).toBe(false)
  })

  test('no arguments is not help', () => {
    expect(triggersTmHelp([])).toBe(false)
  })
})

describe('result shaping', () => {
  test('a non-zero exit marks the result isError and surfaces both streams', async () => {
    const runner = fakeRunner({ code: 2, stdout: 'partial', stderr: 'it broke' })
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    const result = await core.handleTool('send', { args: ['acme'] })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('partial')
    expect(textOf(result)).toContain('it broke')
  })

  test('an unknown tool is an error result', async () => {
    const core = createCore({ runTm: fakeRunner().run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    const result = await core.handleTool('not-a-verb', {})
    expect(result.isError).toBe(true)
  })

  test('a non-string-array args argument is rejected before any shell-out', async () => {
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    const result = await core.handleTool('send', { args: [1, 2] })
    expect(result.isError).toBe(true)
    expect(runner.calls).toHaveLength(0)
  })

  test('a runner that throws becomes an error result, not a rejected call', async () => {
    const runTm: TmRunner = () => Promise.reject(new Error('tm not found'))
    const core = createCore({ runTm, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    const result = await core.handleTool('doctor', {})
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('tm not found')
  })

  test('a code-0 verb with only stderr output is shown plainly, not as an error annex', async () => {
    // `tm spawn` succeeds (exit 0) while printing `spawned:`/`ready:` to stderr.
    const runner = fakeRunner({ code: 0, stdout: '', stderr: 'spawned: acme\n' })
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    const result = await core.handleTool('states', {})
    expect(result.isError).toBe(false)
    expect(textOf(result)).toBe('spawned: acme')
    expect(textOf(result)).not.toContain('--- stderr ---')
  })

  test('both streams are kept distinguishable under a divider', async () => {
    const runner = fakeRunner({ code: 0, stdout: 'the reply', stderr: 'a diagnostic' })
    const core = createCore({ runTm: runner.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    expect(textOf(await core.handleTool('states', {}))).toBe('the reply\n--- stderr ---\na diagnostic')
  })

  test('trailing newlines are trimmed and empty output reports the exit code', async () => {
    const blank = fakeRunner({ code: 0, stdout: '\n\n', stderr: '' })
    const blankCore = createCore({ runTm: blank.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    expect(textOf(await blankCore.handleTool('states', {}))).toContain('exited 0 with no output')

    const trailing = fakeRunner({ code: 0, stdout: 'line\n\n', stderr: '' })
    const trailingCore = createCore({ runTm: trailing.run, registry: freshRegistry(), subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    expect(textOf(await trailingCore.handleTool('states', {}))).toBe('line')
  })
})

describe('the registry tracks the mutating verbs', () => {
  test('a successful spawn records the teammate from its structured repo', async () => {
    const registry = freshRegistry()
    const core = createCore({ runTm: fakeRunner().run, registry, subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    await core.handleTool('spawn', { repo: '__coretest_spawn__' })
    expect(registry.get('__coretest_spawn__')?.repo).toBe('__coretest_spawn__')
  })

  test('a failed spawn records nothing', async () => {
    const registry = freshRegistry()
    const runner = fakeRunner({ code: 1, stderr: 'spawn failed' })
    const core = createCore({ runTm: runner.run, registry, subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    await core.handleTool('spawn', { repo: '__coretest_failed__' })
    expect(registry.get('__coretest_failed__')).toBeUndefined()
  })

  test('a successful kill removes the teammate', async () => {
    const registry = freshRegistry()
    registry.record({ repo: '__coretest_kill__', sid: null, cwd: null })
    const core = createCore({ runTm: fakeRunner().run, registry, subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    await core.handleTool('kill', { repo: '__coretest_kill__' })
    expect(registry.get('__coretest_kill__')).toBeUndefined()
  })

  test('resume records the teammate even when its args carry leading flags', async () => {
    // `tm resume` accepts flags before the repo; the structured `repo` field
    // means the core records the right teammate regardless of `args` order.
    const registry = freshRegistry()
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry, subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
    await core.handleTool('resume', { repo: '__coretest_resume__', args: ['--task', 'slug'] })
    expect(registry.get('__coretest_resume__')?.repo).toBe('__coretest_resume__')
    // The repo is still passed to `tm` as the first argument.
    expect(runner.calls[0]?.args).toEqual(['__coretest_resume__', '--task', 'slug'])
  })

  test('a registry verb with no repo is rejected before any shell-out', async () => {
    const registry = freshRegistry()
    const runner = fakeRunner()
    const core = createCore({ runTm: runner.run, registry, subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })
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
    const core = createCore({ runTm: fakeRunner().run, registry, subscription: fakeSignals, runTmux: fakeTmux, dispatcherDir: '/tmp', projectsDir: '/tmp' })

    const parsed = JSON.parse(textOf(await core.handleTool('teammates', {}))) as {
      teammates: { repo: string; signal: Signal | null }[]
    }
    const byRepo = new Map(parsed.teammates.map((t) => [t.repo, t]))
    expect(byRepo.get('busy-repo')?.signal).toEqual({ busy: true, idle: false })
    expect(byRepo.get('quiet-repo')?.signal).toBeNull()
  })
})
