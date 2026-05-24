/**
 * The CLI front end's routing contract: parse an argument vector and route
 * it to the right handler — native verb, help print, removed-verb error, or
 * unknown-verb error — producing a `TmResult` with the right `code`/`stdout`/
 * `stderr` shape. Bash `bin/tm` is retired on this line, so this file covers
 * every dispatch decision `bin/tm`'s `main` used to make. Byte-exact help
 * text and per-verb output are pinned by `conformance.test.ts`; the unit
 * tests here are about wiring (which handler was reached, with which args).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { runCli } from '../src/cli'
import type { ColumnRunner } from '../src/column'
import type { GrepRunner } from '../src/grep'
import { HELP_TEXTS, OVERVIEW_HELP, REMOVED_VERB_MESSAGES } from '../src/help'
import type { NativeEnv } from '../src/env'
import {
  codexPidFile,
  codexStartedAtFile,
  codexTeammateDir,
} from '../src/engines/codex/persistence'
import {
  cwdFile,
  lastFileFor,
  readyFile,
  sendAtFile,
  sidFile,
} from '../src/paths'
import type { TmuxRunner } from '../src/tmux'
import { TM_VERBS } from '../src/verbs'

const fakeTmux: TmuxRunner = async () => ({ code: 0, stdout: '', stderr: '' })
const fakeColumn: ColumnRunner = async (input) => ({ code: 0, stdout: input, stderr: '' })
const fakeGrep: GrepRunner = async () => 1
let savedCodexRegistryRoot: string | undefined
let codexRegistryRoot: string

beforeAll(() => {
  savedCodexRegistryRoot = process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  codexRegistryRoot = mkdtempSync('/tmp/cmxcli-')
  process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = codexRegistryRoot
})

afterAll(() => {
  if (savedCodexRegistryRoot === undefined) delete process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  else process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = savedCodexRegistryRoot
  rmSync(codexRegistryRoot, { recursive: true, force: true })
})

/** A `NativeEnv` with quiet fakes for every backend. */
function fakeEnv(over: Partial<NativeEnv> = {}): NativeEnv {
  return {
    runTmux: fakeTmux,
    runColumn: fakeColumn,
    runGrep: fakeGrep,
    dispatcherDir: '/tmp',
    projectsDir: '/tmp',
    ...over,
  }
}

describe('bare tm and the help verb', () => {
  test('a bare tm prints the overview and exits 0', async () => {
    const result = await runCli([], fakeEnv())
    expect(result).toEqual({ code: 0, stdout: OVERVIEW_HELP, stderr: '' })
  })

  test('an empty-string verb (tm "") is the same as a bare tm — matches bash ${1:-help}', async () => {
    // Bash `${1:-help}` substitutes the default on unset *or* empty; a dispatcher
    // script that builds argv from a possibly-empty shell variable must not get
    // an "unknown subcommand" surprise.
    expect(await runCli([''], fakeEnv())).toEqual({ code: 0, stdout: OVERVIEW_HELP, stderr: '' })
  })

  test('tm help with no argument prints the overview and exits 0', async () => {
    expect(await runCli(['help'], fakeEnv())).toEqual({ code: 0, stdout: OVERVIEW_HELP, stderr: '' })
  })

  test('tm --help and tm -h are both the overview', async () => {
    expect(await runCli(['--help'], fakeEnv())).toEqual({ code: 0, stdout: OVERVIEW_HELP, stderr: '' })
    expect(await runCli(['-h'], fakeEnv())).toEqual({ code: 0, stdout: OVERVIEW_HELP, stderr: '' })
  })

  test('tm help <verb> prints that verb’s detail page', async () => {
    const result = await runCli(['help', 'ls'], fakeEnv())
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(HELP_TEXTS.ls)
  })

  test('tm help help is the overview — matches bash help_help calling cmd_help', async () => {
    const result = await runCli(['help', 'help'], fakeEnv())
    expect(result).toEqual({ code: 0, stdout: OVERVIEW_HELP, stderr: '' })
  })

  test('tm help <unknown> writes the error to stderr, overview to stdout, exits 1', async () => {
    const result = await runCli(['help', 'nope'], fakeEnv())
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('tm: no help for unknown verb: nope\n')
    expect(result.stdout).toBe(OVERVIEW_HELP)
  })
})

describe('tm <verb> --help pre-scan', () => {
  test('tm <verb> --help prints that verb’s detail page', async () => {
    const result = await runCli(['ls', '--help'], fakeEnv())
    expect(result).toEqual({ code: 0, stdout: HELP_TEXTS.ls, stderr: '' })
  })

  test('tm <verb> -h is the same as --help', async () => {
    const result = await runCli(['spawn', '-h'], fakeEnv())
    expect(result).toEqual({ code: 0, stdout: HELP_TEXTS.spawn, stderr: '' })
  })

  test('flags before --help do not stop the pre-scan', async () => {
    const result = await runCli(['send', '--pane-quiet', '--help'], fakeEnv())
    expect(result).toEqual({ code: 0, stdout: HELP_TEXTS.send, stderr: '' })
  })

  test('the first positional stops the pre-scan — a later --help is data', async () => {
    // `last` has no marker file for this repo, so the native handler errors
    // out — proving the verb dispatched, not the help branch.
    const result = await runCli(['last', 'some-repo', '--help'], fakeEnv())
    expect(result.code).not.toBe(0)
    expect(result.stdout).not.toBe(HELP_TEXTS.last)
  })

  test('a --prompt value stops the pre-scan — the next --help is its argument', async () => {
    // `send` will dispatch and fail on the missing teammate — what we care
    // about is that the pre-scan stopped, not what the failure said.
    const result = await runCli(['send', '--prompt', '--help'], fakeEnv())
    expect(result.stdout).not.toBe(HELP_TEXTS.send)
  })

  test('an unknown verb plus --help falls through to the overview, not an error', async () => {
    // Matches bash: `declare -F help_<unknown>` fails, `cmd_help` runs.
    const result = await runCli(['fubar', '--help'], fakeEnv())
    expect(result).toEqual({ code: 0, stdout: OVERVIEW_HELP, stderr: '' })
  })
})

describe('removed verbs', () => {
  test.each(Object.keys(REMOVED_VERB_MESSAGES))('%s prints the migration message and exits 2', async (verb) => {
    const result = await runCli([verb], fakeEnv())
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe(REMOVED_VERB_MESSAGES[verb])
  })

  test('a removed verb with --help still routes to overview', async () => {
    // Matches bash's pre-scan: --help wins, the removed-verb arm is
    // never reached. `wait-idle` is a stable removed verb (stage 4
    // re-introduced `ask`, so we test against a verb that stays
    // retired).
    const result = await runCli(['wait-idle', '--help'], fakeEnv())
    expect(result).toEqual({ code: 0, stdout: OVERVIEW_HELP, stderr: '' })
  })

  test('a removed verb with a positional argument still hits the migration error', async () => {
    // The positional stops the pre-scan, so dispatch reaches the removed arm.
    const result = await runCli(['wait-idle', 'repo'], fakeEnv())
    expect(result.code).toBe(2)
    expect(result.stderr).toBe(REMOVED_VERB_MESSAGES['wait-idle'])
  })
})

describe('unknown verb', () => {
  test('writes "tm: unknown subcommand" to stderr, overview to stdout, exits 1', async () => {
    const result = await runCli(['fubar'], fakeEnv())
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('tm: unknown subcommand: fubar\n')
    expect(result.stdout).toBe(OVERVIEW_HELP)
  })

  // A bare `NATIVE_VERBS[verb]` lookup walks the prototype chain, so verbs
  // like `toString` / `constructor` / `hasOwnProperty` / `__proto__` would
  // yield a function (or object) from `Object.prototype` instead of
  // `undefined` — dispatch would then call that function as a NativeVerb (or
  // shove it into `stdout`) and crash the launcher's writer. Same surface
  // exists on `HELP_TEXTS[verb]` and `REMOVED_VERB_MESSAGES[verb]`; gate them
  // with `Object.hasOwn`.
  test.each(['toString', 'constructor', 'hasOwnProperty', '__proto__'])(
    'verb "%s" (Object.prototype key) is treated as unknown, not dispatched',
    async (verb) => {
      const result = await runCli([verb], fakeEnv())
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(`tm: unknown subcommand: ${verb}\n`)
      expect(result.stdout).toBe(OVERVIEW_HELP)
    },
  )

  test.each(['toString', 'constructor', 'hasOwnProperty', '__proto__'])(
    '`tm help %s` (Object.prototype key) is treated as an unknown help target',
    async (verb) => {
      const result = await runCli(['help', verb], fakeEnv())
      expect(result.code).toBe(1)
      expect(result.stderr).toBe(`tm: no help for unknown verb: ${verb}\n`)
      expect(result.stdout).toBe(OVERVIEW_HELP)
    },
  )

  test.each(['toString', 'constructor', 'hasOwnProperty', '__proto__'])(
    '`tm %s --help` (Object.prototype key in pre-scan) falls through to the overview',
    async (verb) => {
      const result = await runCli([verb, '--help'], fakeEnv())
      expect(result).toEqual({ code: 0, stdout: OVERVIEW_HELP, stderr: '' })
    },
  )
})

describe('native dispatch', () => {
  test('every TM_VERBS entry has a HELP_TEXTS entry', () => {
    // Pin the help catalog against the verb catalog so a new verb cannot
    // ship without help.
    for (const verb of TM_VERBS) {
      expect(HELP_TEXTS[verb.name], `HELP_TEXTS["${verb.name}"]`).toBeDefined()
    }
  })

  test('ls routes through the Engine layer (Phase 2a-1), returning a structured teammate row', async () => {
    // Phase 2a-1: `tm ls` now goes through `ClaudeEngine.list()` and the
    // verb-side formatter, so the row is `name\tengine\tstate\tcwd\n`
    // with the `teammate-` prefix stripped from the tmux session name.
    const result = await runCli(
      ['ls'],
      fakeEnv({ runTmux: async () => ({ code: 0, stdout: 'teammate-x: 1 windows\n', stderr: '' }) }),
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('x\tclaude')
  })

  test('arguments reach the native handler', async () => {
    // No marker files exist for this repo, so the native `last` handler dies
    // with an error echoing the repo — proving the argv tail reached it.
    const result = await runCli(['last', '__cli_argv_probe__'], fakeEnv())
    expect(result.code).not.toBe(0)
    expect(result.stdout + result.stderr).toContain('__cli_argv_probe__')
  })

  test('archive stdin is forwarded to the native handler', async () => {
    // archive needs a real ledger to do anything — pass stdin and confirm the
    // verb at least got past dispatch (it will fail on the missing ledger).
    const result = await runCli(['archive', 'task-9'], fakeEnv(), 'no ledger here')
    expect(result.code).not.toBe(0)
  })

  test('explicit Claude spawn is not hijacked by a stale codex registry entry', async () => {
    const repo = `stale-claude-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    const repoDir = join(dispatcherDir, repo)
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(codexTeammateDir(repo), { recursive: true })
    writeFileSync(codexPidFile(repo), `${process.pid}\n`)
    writeFileSync(codexStartedAtFile(repo), `${Math.floor(Date.now() / 1000)}\n`)
    const tmuxCalls: string[][] = []
    const runTmux: TmuxRunner = async (args) => {
      tmuxCalls.push([...args])
      if (args[0] === 'has-session') return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'new-session') {
        mkdirSync(dirname(readyFile(repo)), { recursive: true })
        writeFileSync(readyFile(repo), '')
        return { code: 0, stdout: '%1\n', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }

    try {
      const result = await runCli(
        ['spawn', repo, '--engine', 'claude'],
        fakeEnv({ dispatcherDir, runTmux }),
      )
      expect(result.code).toBe(0)
      expect(tmuxCalls.some((args) => args[0] === 'new-session')).toBe(true)
      expect(result.stderr).toContain(`tmux=teammate-${repo}`)
    } finally {
      const sid = existsSync(sidFile(repo)) ? readFileSync(sidFile(repo), 'utf8').trim() : ''
      rmSync(dispatcherDir, { recursive: true, force: true })
      rmSync(cwdFile(repo), { force: true })
      rmSync(sidFile(repo), { force: true })
      rmSync(readyFile(repo), { force: true })
      rmSync(sendAtFile(repo), { force: true })
      if (sid.length > 0) rmSync(lastFileFor(sid), { force: true })
      rmSync(codexTeammateDir(repo), { recursive: true, force: true })
    }
  })
})

describe('engine-routed verbs (Phase 2a-1 fleet visibility)', () => {
  // Decision 0024 §"Fleet-visibility verbs" routes `tm ls` / `tm states` /
  // `tm status` through `EngineRegistry` instead of straight to tmux. The
  // tests here cover the dispatch wiring; per-engine output shape is
  // covered by ClaudeEngine's own unit tests + the conformance file
  // (which is updated when Phase 2a-2 inlines the verb bodies).
  //
  // `tm kill` is NOT in this set yet: the legacy NATIVE_VERBS.kill carries
  // an `isCodexTarget` codex hand-off that has no replacement until Phase
  // 2b registers a CodexEngine. Routing `kill` through ClaudeEngine
  // prematurely would silently regress `tm kill codex-<n>` callers.

  test('tm states returns code 0 with the empty-fleet pointer line', async () => {
    const result = await runCli(
      ['states'],
      fakeEnv({ runTmux: async () => ({ code: 0, stdout: '', stderr: '' }) }),
    )
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('(no teammate sessions)\n')
  })

  test('tm status without a repo fails with a usage line', async () => {
    const result = await runCli(['status'], fakeEnv())
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('tm status <repo>')
  })

  test('tm status for a missing teammate returns not-found via the router', async () => {
    // No tmux session matches `=teammate-missing`, so the legacy fallback
    // router resolves `null` and the verb formats "no such teammate".
    const result = await runCli(
      ['status', 'missing'],
      fakeEnv({ runTmux: async () => ({ code: 1, stdout: '', stderr: '' }) }),
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no such teammate')
  })
})

describe('doctor — sections fire top-down, never raising', () => {
  // `doctor` is not in the conformance harness: it reports the path to the
  // *current* tm binary, which differs between bash `bin/tm` and the native
  // CLI launcher. This pins each section's presence and shape, since byte-
  // for-byte parity with bash is not the migration's intent here.

  // Each parallel vitest worker needs its own codex registry root so
  // doctor's codex-teammate section does not see entries left behind by
  // the supervisor / verbs test files.
  let savedRegistryRoot: string | undefined
  let registryDir: string
  beforeAll(() => {
    // Short `/tmp` root rather than `$TMPDIR` so the supervisor's unix
    // socket nodes (under `<root>/<name>/socket`) stay under macOS's
    // ~104-char path limit. Doctor itself does not bind sockets, but
    // sharing the root with the engines/codex verbs / supervisor test contract
    // is the safer pattern.
    registryDir = mkdtempSync('/tmp/cmxc-')
    savedRegistryRoot = process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
    process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = registryDir
  })
  afterAll(() => {
    if (savedRegistryRoot === undefined) delete process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
    else process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = savedRegistryRoot
    rmSync(registryDir, { recursive: true, force: true })
  })

  test('reports every section, in order, and exits 0', async () => {
    const result = await runCli(
      ['doctor'],
      fakeEnv({
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
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    // Sections in order; the heading text is the load-bearing contract.
    const idx = (heading: string): number => result.stdout.indexOf(heading)
    expect(idx('tm executable:')).toBeGreaterThanOrEqual(0)
    expect(idx('dispatcher dir:')).toBeGreaterThan(idx('tm executable:'))
    expect(idx('tmux:')).toBeGreaterThan(idx('dispatcher dir:'))
    expect(idx('idle dir (')).toBeGreaterThan(idx('tmux:'))
    expect(idx('active teammates:')).toBeGreaterThan(idx('idle dir ('))
    expect(idx('codex teammates:')).toBeGreaterThan(idx('active teammates:'))
  })

  test('the codex section reports "none" when no codex teammates exist', async () => {
    // With a private registry root (set in beforeAll above) no other test
    // file can land entries here, so the "none" body is stable.
    const result = await runCli(['doctor'], fakeEnv())
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/codex teammates:\s*\n  \(none — use 'tm spawn codex-<n>' to launch one\)/)
  })

  test('the reported tm executable path is the production launcher, not the dev wrapper', async () => {
    // Doctor's job is to tell the user which `tm` actually runs — if it
    // reports the dev `tsx`-based launcher when the production node-bundle
    // launcher is what's on PATH, a confused user follows a path that won't
    // start (no `tsx` outside the dev tree). Pin that the path ends at the
    // production launcher under `<plugin-root>/bin/tm`, never the dev one
    // at `core/bin/tm`.
    const result = await runCli(['doctor'], fakeEnv())
    expect(result.code).toBe(0)
    expect(result.stdout).toMatch(/path:\s+.*\/plugins\/claudemux\/bin\/tm$/m)
    expect(result.stdout).not.toMatch(/path:\s+.*\/core\/bin\/tm/m)
  })

  test('rejects positional arguments with the usage error', async () => {
    const result = await runCli(['doctor', 'extra'], fakeEnv())
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('tm doctor: takes no arguments')
  })
})
