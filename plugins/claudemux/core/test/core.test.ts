/**
 * The verb dispatch contract: `runVerb` runs a migrated verb as native code
 * and shells every other verb out to `tm`, and a `--help` invocation shells
 * out even for a migrated verb. The native-vs-`tm` *behavior* match is pinned
 * separately by `conformance.test.ts`; this file tests the dispatch wiring.
 */

import { describe, expect, test } from 'vitest'

import type { ColumnRunner } from '../src/column'
import { runVerb } from '../src/core'
import type { GrepRunner } from '../src/grep'
import { isNativeVerb, type NativeEnv, triggersTmHelp } from '../src/native'
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

/** A quiet fake `tmux` runner — enough for a native verb's dependency. */
const fakeTmux: TmuxRunner = async () => ({ code: 0, stdout: '', stderr: '' })
/** A fake `column` runner — echoes its input. */
const fakeColumn: ColumnRunner = async (input) => ({ code: 0, stdout: input, stderr: '' })
/** A fake `grep` runner — reports no match. */
const fakeGrep: GrepRunner = async () => 1

/** A `NativeEnv` whose `tm` shell-out is the given fake runner. */
function fakeEnv(runTm: TmRunner, over: Partial<NativeEnv> = {}): NativeEnv {
  return {
    runTm,
    runTmux: fakeTmux,
    runColumn: fakeColumn,
    runGrep: fakeGrep,
    dispatcherDir: '/tmp',
    projectsDir: '/tmp',
    ...over,
  }
}

describe('a non-native verb shells out to tm', () => {
  // After stage 3 every TM_VERB is migrated, so the shell-out path is reached
  // only for verb names not in `NATIVE_VERBS`. A synthetic name below pins the
  // wiring without depending on which verbs are migrated yet. (The verb-loop
  // covers every still-unmigrated TM_VERB if any remain.)
  const UNMIGRATED = '__core_test_unmigrated_verb__'

  for (const verb of TM_VERBS.filter((v) => !isNativeVerb(v.name))) {
    test(`${verb.name} reaches tm with its verb name and arguments`, async () => {
      const runner = fakeRunner()
      await runVerb(verb.name, ['alpha', '--flag', 'beta'], undefined, fakeEnv(runner.run))
      expect(runner.calls).toHaveLength(1)
      expect(runner.calls[0]?.verb).toBe(verb.name)
      expect(runner.calls[0]?.args).toEqual(['alpha', '--flag', 'beta'])
    })
  }

  test('a verb with no args forwards an empty argument vector', async () => {
    const runner = fakeRunner()
    await runVerb(UNMIGRATED, [], undefined, fakeEnv(runner.run))
    expect(runner.calls[0]?.args).toEqual([])
  })

  test('stdin is forwarded to the runner', async () => {
    const runner = fakeRunner()
    await runVerb(UNMIGRATED, [], { stdin: 'task-9' }, fakeEnv(runner.run))
    expect(runner.calls[0]?.stdin).toBe('task-9')
  })

  test('the verb result is returned unshaped', async () => {
    const runner = fakeRunner({ code: 2, stdout: 'partial', stderr: 'it broke' })
    const result = await runVerb(UNMIGRATED, ['acme'], undefined, fakeEnv(runner.run))
    expect(result).toEqual({ code: 2, stdout: 'partial', stderr: 'it broke' })
  })
})

describe('a migrated verb runs natively, not through tm', () => {
  test('ls is served from tmux, never reaching the tm shell-out', async () => {
    const runner = fakeRunner()
    const result = await runVerb(
      'ls',
      [],
      undefined,
      fakeEnv(runner.run, {
        runTmux: async () => ({ code: 0, stdout: 'teammate-x: 1 windows\n', stderr: '' }),
      }),
    )
    expect(runner.calls).toHaveLength(0)
    expect(result.stdout).toContain('teammate-x')
  })

  test('ls masks a tmux that cannot be spawned, like `tmux ls || true`', async () => {
    const runner = fakeRunner()
    // A `runTmux` that rejects stands in for a missing or unspawnable tmux;
    // native `ls` tolerates it and reports an empty fleet, never the shell-out.
    const result = await runVerb(
      'ls',
      [],
      undefined,
      fakeEnv(runner.run, { runTmux: () => Promise.reject(new Error('tmux not found')) }),
    )
    expect(runner.calls).toHaveLength(0)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('no teammate sessions')
  })

  test("a native verb's arguments reach its handler", async () => {
    const runner = fakeRunner()
    // No marker files exist for this repo, so the native `last` handler returns
    // its own error echoing the repo — proving `argv` reached the native
    // handler rather than the call going to `runTm`.
    const result = await runVerb('last', ['__coretest_argv_probe__'], undefined, fakeEnv(runner.run))
    expect(runner.calls).toHaveLength(0)
    expect(result.code).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('__coretest_argv_probe__')
  })

  test('reload runs natively and never reaches the tm shell-out', async () => {
    const runner = fakeRunner()
    // After stage 3 `reload` fans out to the in-process native `send`, not a
    // `tm send` subprocess. The native `send` here will die (no tmux session
    // for `repo-x`), but the verb is reached natively and stops at that — the
    // shell-out runner stays untouched, and the arrow line still prints.
    const result = await runVerb('reload', ['repo-x'], undefined, fakeEnv(runner.run))
    expect(runner.calls).toHaveLength(0)
    expect(result.stdout).toContain('→ repo-x: /reload-plugins')
  })
})

describe('a --help invocation shells out even for a migrated verb', () => {
  test('ls --help reaches tm, where the per-verb help text lives', async () => {
    const runner = fakeRunner()
    await runVerb('ls', ['--help'], undefined, fakeEnv(runner.run))
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.verb).toBe('ls')
    expect(runner.calls[0]?.args).toEqual(['--help'])
  })

  test('a --help after the first positional does not trigger help — last still runs natively', async () => {
    const runner = fakeRunner()
    // `tm`'s pre-scan stops at the first positional, so a later `--help` is an
    // ordinary argument — the verb runs natively, it does not show help.
    const result = await runVerb(
      'last',
      ['__coretest_probe__', '--help'],
      undefined,
      fakeEnv(runner.run),
    )
    expect(runner.calls).toHaveLength(0)
    expect(result.code).not.toBe(0)
  })
})

describe('doctor — sections fire top-down, never raising', () => {
  // `doctor` is not in the conformance harness: it reports the path to the
  // *current* tm binary, which differs between bash `bin/tm` and the native
  // CLI wrapper. The probe below exercises the native verb directly and
  // pins each section's presence and shape, since byte-for-byte parity with
  // bash is not the migration's intent here.
  test('reports every section, in order, and exits 0', async () => {
    const runner = fakeRunner()
    const result = await runVerb(
      'doctor',
      [],
      undefined,
      fakeEnv(runner.run, {
        // A tmux probe that succeeds; the section just needs the version line.
        runTmux: async (args) => {
          const verb = args[0]
          if (verb === '-V') return { code: 0, stdout: 'tmux 3.4\n', stderr: '' }
          if (verb === 'info') return { code: 0, stdout: '', stderr: '' }
          if (verb === 'ls') return { code: 1, stdout: '', stderr: 'no server' }
          return { code: 0, stdout: '', stderr: '' }
        },
      }),
    )
    expect(runner.calls).toHaveLength(0)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    // Sections in order; the heading text is the load-bearing contract.
    const idx = (heading: string): number => result.stdout.indexOf(heading)
    expect(idx('tm executable:')).toBeGreaterThanOrEqual(0)
    expect(idx('dispatcher dir:')).toBeGreaterThan(idx('tm executable:'))
    expect(idx('tmux:')).toBeGreaterThan(idx('dispatcher dir:'))
    expect(idx('idle dir (')).toBeGreaterThan(idx('tmux:'))
    expect(idx('active teammates:')).toBeGreaterThan(idx('idle dir ('))
  })

  test('rejects positional arguments with the usage error', async () => {
    const runner = fakeRunner()
    const result = await runVerb('doctor', ['extra'], undefined, fakeEnv(runner.run))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('tm doctor: takes no arguments')
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
