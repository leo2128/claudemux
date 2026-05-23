/**
 * The CLI front end's dispatch contract: an argument vector splits into a verb
 * and its arguments, a migrated verb runs natively while the rest shell out to
 * `tm`, stdin is forwarded, and a bare `tm` reaches the shell-out so `tm` owns
 * its no-verb help. The native-vs-`tm` *behavior* match is pinned separately
 * by `conformance.test.ts`; this file tests the front end's wiring.
 */

import { describe, expect, test } from 'vitest'

import { type CliDeps, runCli } from '../src/cli'
import type { ColumnRunner } from '../src/column'
import type { GrepRunner } from '../src/grep'
import type { RawTmRunner, TmResult, TmRunner } from '../src/tm'
import type { TmuxRunner } from '../src/tmux'

/** A `CliDeps` whose `tm` shell-outs are fakes that record every call. */
function fakeDeps(
  over: Partial<CliDeps> = {},
  tmResult: Partial<TmResult> = {},
): {
  deps: CliDeps
  tmCalls: { verb: string; args: readonly string[]; stdin?: string }[]
  rawCalls: { args: readonly string[]; stdin?: string }[]
} {
  const tmCalls: { verb: string; args: readonly string[]; stdin?: string }[] = []
  const rawCalls: { args: readonly string[]; stdin?: string }[] = []
  const runTm: TmRunner = async (verb, args, options) => {
    tmCalls.push({ verb, args, stdin: options?.stdin })
    return { code: 0, stdout: `ran ${verb}`, stderr: '', ...tmResult }
  }
  const runTmRaw: RawTmRunner = async (args, options) => {
    rawCalls.push({ args, stdin: options?.stdin })
    return { code: 0, stdout: 'tm help', stderr: '', ...tmResult }
  }
  const runTmux: TmuxRunner = async () => ({ code: 0, stdout: '', stderr: '' })
  const runColumn: ColumnRunner = async (input) => ({ code: 0, stdout: input, stderr: '' })
  const runGrep: GrepRunner = async () => 1
  const deps: CliDeps = {
    runTm,
    runTmRaw,
    runTmux,
    runColumn,
    runGrep,
    dispatcherDir: '/tmp',
    projectsDir: '/tmp',
    ...over,
  }
  return { deps, tmCalls, rawCalls }
}

describe('a non-native verb shells out to tm', () => {
  // After stage 3 every TM_VERB is migrated, so the shell-out path is reached
  // only when the verb name is not in `NATIVE_VERBS`. The synthetic name below
  // pins that path without depending on which verbs are migrated yet.
  const UNMIGRATED = '__cli_test_unmigrated_verb__'

  test('the verb name and its arguments reach the tm shell-out', async () => {
    const { deps, tmCalls, rawCalls } = fakeDeps()
    await runCli([UNMIGRATED, 'acme', '--flag', 'beta'], deps)
    expect(tmCalls).toHaveLength(1)
    expect(tmCalls[0]?.verb).toBe(UNMIGRATED)
    expect(tmCalls[0]?.args).toEqual(['acme', '--flag', 'beta'])
    expect(rawCalls).toHaveLength(0)
  })

  test('a verb with no arguments shells out an empty argument vector', async () => {
    const { deps, tmCalls } = fakeDeps()
    await runCli([UNMIGRATED], deps)
    expect(tmCalls[0]?.verb).toBe(UNMIGRATED)
    expect(tmCalls[0]?.args).toEqual([])
  })

  test('stdin is forwarded to the shell-out', async () => {
    const { deps, tmCalls } = fakeDeps()
    await runCli([UNMIGRATED], deps, 'task-9')
    expect(tmCalls[0]?.stdin).toBe('task-9')
  })

  test('the verb result is returned faithfully', async () => {
    const { deps } = fakeDeps({}, { code: 2, stdout: 'partial', stderr: 'it broke' })
    const result = await runCli([UNMIGRATED, 'acme'], deps)
    expect(result).toEqual({ code: 2, stdout: 'partial', stderr: 'it broke' })
  })
})

describe('a migrated verb runs natively, not through tm', () => {
  test('ls is served from tmux, never reaching a shell-out', async () => {
    const { deps, tmCalls, rawCalls } = fakeDeps({
      runTmux: async () => ({ code: 0, stdout: 'teammate-x: 1 windows\n', stderr: '' }),
    })
    const result = await runCli(['ls'], deps)
    expect(tmCalls).toHaveLength(0)
    expect(rawCalls).toHaveLength(0)
    expect(result.stdout).toContain('teammate-x')
  })

  test("the verb's arguments reach the native handler", async () => {
    const { deps, tmCalls } = fakeDeps()
    // No marker files exist for this repo, so the native `last` handler returns
    // its own error echoing the repo — proving the argv split handed `rest` to
    // the native handler rather than the call reaching `runTm`.
    const result = await runCli(['last', '__cli_argv_probe__'], deps)
    expect(tmCalls).toHaveLength(0)
    expect(result.code).not.toBe(0)
    expect(result.stderr + result.stdout).toContain('__cli_argv_probe__')
  })

  test('a --help invocation shells out even for a migrated verb', async () => {
    const { deps, tmCalls } = fakeDeps()
    await runCli(['ls', '--help'], deps)
    expect(tmCalls).toHaveLength(1)
    expect(tmCalls[0]?.verb).toBe('ls')
    expect(tmCalls[0]?.args).toEqual(['--help'])
  })
})

describe('a bare tm reaches the shell-out', () => {
  test('an empty argument vector shells out a raw, empty argv', async () => {
    const { deps, tmCalls, rawCalls } = fakeDeps()
    await runCli([], deps)
    expect(rawCalls).toHaveLength(1)
    expect(rawCalls[0]?.args).toEqual([])
    expect(tmCalls).toHaveLength(0)
  })

  test('an unknown verb still reaches tm, which owns the error', async () => {
    const { deps, tmCalls } = fakeDeps()
    // An unknown verb is not native, so it shells out like any other verb —
    // bash `tm` produces the unknown-verb error.
    await runCli(['not-a-verb', 'x'], deps)
    expect(tmCalls).toHaveLength(1)
    expect(tmCalls[0]?.verb).toBe('not-a-verb')
    expect(tmCalls[0]?.args).toEqual(['x'])
  })
})
