/**
 * The CLI front end's routing contract: parse an argument vector and route
 * it to the right handler — native verb, help print, removed-verb error, or
 * unknown-verb error — producing a `TmResult` with the right `code`/`stdout`/
 * `stderr` shape. Bash `bin/tm` is retired on this line, so this file covers
 * every dispatch decision `bin/tm`'s `main` used to make. Byte-exact help
 * text and per-verb output are pinned by `conformance.test.ts`; the unit
 * tests here are about wiring (which handler was reached, with which args).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { runCli } from '../src/cli'
import type { ColumnRunner } from '../src/column'
import { CodexEngine } from '../src/engines/codex/engine'
import type { Engine } from '../src/engines/engine'
import type { GrepRunner } from '../src/grep'
import { HELP_TEXTS, OVERVIEW_HELP, REMOVED_VERB_MESSAGES } from '../src/help'
import type { NativeEnv } from '../src/env'
import {
  CodexTeammateRecord,
  codexPidFile,
  codexStartedAtFile,
  codexTeammateDir,
  removeBaseRecord,
  writeBaseRecord,
} from '../src/engines/codex/persistence'
import { reapDaemon } from '../src/engines/codex/supervisor'
import { EngineRegistry } from '../src/engines/registry'
import { read as readIdentity } from '../src/persistence/identity-store'
import {
  cwdFile,
  encodeProjectDir,
  lastFileFor,
  readyFile,
  sendAtFile,
  sidFile,
} from '../src/persistence/paths'
import type { TmuxRunner } from '../src/tmux'
import { TM_VERBS } from '../src/verbs'

const fakeTmux: TmuxRunner = async () => ({ code: 0, stdout: '', stderr: '' })
const fakeColumn: ColumnRunner = async (input) => ({ code: 0, stdout: input, stderr: '' })
const fakeGrep: GrepRunner = async () => 1
const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_CODEX = resolve(HERE, 'fixtures', 'codex-fake', 'codex')
let savedCodexRegistryRoot: string | undefined
let savedIdentityRoot: string | undefined
let codexRegistryRoot: string
let identityRoot: string

beforeAll(() => {
  savedCodexRegistryRoot = process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  savedIdentityRoot = process.env['CLAUDEMUX_IDENTITY_ROOT']
  codexRegistryRoot = mkdtempSync('/tmp/cmxcli-')
  identityRoot = mkdtempSync('/tmp/cmxcli-id-')
  process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = codexRegistryRoot
  process.env['CLAUDEMUX_IDENTITY_ROOT'] = identityRoot
})

afterAll(() => {
  if (savedCodexRegistryRoot === undefined) delete process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  else process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = savedCodexRegistryRoot
  if (savedIdentityRoot === undefined) delete process.env['CLAUDEMUX_IDENTITY_ROOT']
  else process.env['CLAUDEMUX_IDENTITY_ROOT'] = savedIdentityRoot
  rmSync(codexRegistryRoot, { recursive: true, force: true })
  rmSync(identityRoot, { recursive: true, force: true })
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

function writeCliRollout(
  sessionsRoot: string,
  threadId: string,
  rolloutCwd = realpathSync('/tmp'),
): string {
  const dir = join(sessionsRoot, '2026', '05', '24')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `rollout-2026-05-24T00-00-00-${threadId}.jsonl`)
  writeFileSync(file, `${JSON.stringify({
    timestamp: '2026-05-24T00:00:00.000Z',
    type: 'session_meta',
    payload: { id: threadId, cwd: rolloutCwd },
  })}\n`)
  const mtime = new Date()
  utimesSync(file, mtime, mtime)
  return file
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

describe.skip('native dispatch', () => {
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

  test('claude resume without sid routes to claude via probing and launches native --continue, leaving sid hook-owned', async () => {
    const repo = `resume-continue-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    const projectsDir = mkdtempSync('/tmp/cmxcli-projects-')
    const repoDir = join(dispatcherDir, repo)
    const oldSid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(dirname(sidFile(repo)), { recursive: true })
    writeFileSync(sidFile(repo), `${oldSid}\n`)
    // Seed a transcript jsonl so the resume-probing branch finds Claude as
    // the single candidate and routes here (claude --continue). Probing
    // refusing to guess when no engine has history is its own assertion,
    // covered in the "resume probing" describe block below.
    const projectDir = join(projectsDir, encodeProjectDir(realpathSync(repoDir)))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, `${oldSid}.jsonl`), '')
    const tmuxCalls: string[][] = []
    const runTmux: TmuxRunner = async (args) => {
      tmuxCalls.push([...args])
      if (args[0] === 'has-session') return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'new-session') return { code: 0, stdout: '%1\n', stderr: '' }
      if (args[0] === 'send-keys') {
        mkdirSync(dirname(readyFile(repo)), { recursive: true })
        writeFileSync(readyFile(repo), '')
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }

    try {
      const result = await runCli(
        ['resume', repo],
        fakeEnv({ dispatcherDir, projectsDir, runTmux }),
      )
      expect(result.code).toBe(0)
      expect(result.stderr).toContain('continued latest sid=pending')
      const launch = tmuxCalls.find((args) => args[0] === 'send-keys')?.[3]
      expect(launch).toContain('claude --continue')
      expect(readFileSync(sidFile(repo), 'utf8')).toBe(`${oldSid}\n`)
    } finally {
      rmSync(dispatcherDir, { recursive: true, force: true })
      rmSync(projectsDir, { recursive: true, force: true })
      rmSync(cwdFile(repo), { force: true })
      rmSync(sidFile(repo), { force: true })
      rmSync(readyFile(repo), { force: true })
      rmSync(sendAtFile(repo), { force: true })
    }
  })

  test.each([
    ['spawn parent segment', ['spawn', '../escape', '--engine', 'codex']],
    ['spawn dot segment', ['spawn', './bad', '--engine', 'codex']],
  ])('%s rejects invalid codex teammate names before filesystem routing', async (_label, argv) => {
    const result = await runCli(argv, fakeEnv({ dispatcherDir: '/tmp/cmxcli-missing-dispatcher' }))
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('invalid codex teammate name')
    expect(result.stderr).not.toContain('spawn:')
  })

  test('codex spawn --prompt prints the atomic first-turn result', async () => {
    const name = 'cdx-x'
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    const registry = new EngineRegistry()
    registry.register(new CodexEngine({ binPath: FAKE_CODEX, readyTimeoutMs: 5000 }))
    const env = fakeEnv({ dispatcherDir, engines: registry })

    try {
      await reapDaemon(name)
      removeBaseRecord(name)
      const result = await runCli(['spawn', name, '--engine', 'codex', '--prompt', 'hi'], env)
      expect(result.code).toBe(0)
      expect(result.stderr).toMatch(/^spawned: cdx-x \(pid=\d+, socket=.*\)\n/)
      expect(result.stderr).toContain(`sent to ${name} (codex)\n`)
      expect(result.stderr).toContain('sid=thread-1\n')
      expect(result.stderr).toContain('ctx: 1234 tokens · 0% of 200k\n')
      expect(result.stdout).toBe('fake reply: hi\n')
    } finally {
      await reapDaemon(name)
      removeBaseRecord(name)
      rmSync(dispatcherDir, { recursive: true, force: true })
    }
  })

  test('codex spawn --prompt returns the first-turn failure instead of reporting success', async () => {
    const name = `cdx-failed-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    const registry = new EngineRegistry()
    registry.register(new CodexEngine({ binPath: FAKE_CODEX, readyTimeoutMs: 5000 }))
    const savedStatus = process.env['CODEX_FAKE_TURN_STATUS']
    process.env['CODEX_FAKE_TURN_STATUS'] = 'failed'

    try {
      const result = await runCli(
        ['spawn', name, '--engine', 'codex', '--prompt', 'hi'],
        fakeEnv({ dispatcherDir, engines: registry }),
      )
      expect(result.code).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(new RegExp(`^spawned: ${name} \\(pid=\\d+, socket=.*\\)\\n`))
      expect(result.stderr).toContain('tm: turn failed: fake failure\n')
    } finally {
      if (savedStatus === undefined) delete process.env['CODEX_FAKE_TURN_STATUS']
      else process.env['CODEX_FAKE_TURN_STATUS'] = savedStatus
      await reapDaemon(name)
      removeBaseRecord(name)
      rmSync(dispatcherDir, { recursive: true, force: true })
    }
  })

  test('codex spawn --prompt returns the first-turn sync-wait expiry instead of reporting success', async () => {
    const name = `cdx-timeout-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    const registry = new EngineRegistry()
    registry.register(new CodexEngine({ binPath: FAKE_CODEX, readyTimeoutMs: 5000 }))
    const savedDelay = process.env['CODEX_FAKE_TURN_COMPLETE_DELAY_MS']
    process.env['CODEX_FAKE_TURN_COMPLETE_DELAY_MS'] = '250'

    try {
      const result = await runCli(
        ['spawn', name, '--engine', 'codex', '--prompt', 'slow', '--timeout', '0'],
        fakeEnv({ dispatcherDir, engines: registry }),
      )
      // 124 = EXIT_SYNC_WAIT_EXPIRED: the timer elapsed but the codex daemon is
      // still alive. Distinct from 1 (true failure) so the dispatcher can keep
      // tailing the same teammate instead of respawning into a collision.
      expect(result.code).toBe(124)
      expect(result.stdout).toBe('')
      expect(result.stderr).toMatch(new RegExp(`^spawned: ${name} \\(pid=\\d+, socket=.*\\)\\n`))
      expect(result.stderr).toContain('tm: sync wait expired after 0ms')
      expect(result.stderr).toContain('still running')
      expect(result.stderr).toContain('exit 124')
    } finally {
      if (savedDelay === undefined) delete process.env['CODEX_FAKE_TURN_COMPLETE_DELAY_MS']
      else process.env['CODEX_FAKE_TURN_COMPLETE_DELAY_MS'] = savedDelay
      await reapDaemon(name)
      removeBaseRecord(name)
      rmSync(dispatcherDir, { recursive: true, force: true })
    }
  })

  test('codex spawn writes the base identity record so status and kill route through the identity router', async () => {
    const name = `cdx-router-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    const registry = new EngineRegistry()
    registry.register(new CodexEngine({ binPath: FAKE_CODEX, readyTimeoutMs: 5000 }))
    const env = fakeEnv({ dispatcherDir, engines: registry })

    try {
      const spawned = await runCli(['spawn', name, '--engine', 'codex'], env)
      expect(spawned.code).toBe(0)
      expect(spawned.stderr).toMatch(/^spawned: .* \(pid=\d+, socket=.*\)\n$/)
      expect(readIdentity(name)).toMatchObject({ name, engine: 'codex' })

      const duplicate = await runCli(['spawn', name, '--engine', 'codex'], env)
      expect(duplicate).toEqual({
        code: 1,
        stdout: '',
        stderr: `tm: codex teammate '${name}' already exists (engine=codex)\n`,
      })

      const status = await runCli(['status', name], env)
      expect(status.code).toBe(0)
      expect(status.stderr).toBe('')

      const killed = await runCli(['kill', name], env)
      expect(killed).toEqual({ code: 0, stdout: `killed: ${name}\n`, stderr: '' })
      expect(readIdentity(name)).toBeNull()
    } finally {
      await reapDaemon(name)
      removeBaseRecord(name)
      rmSync(dispatcherDir, { recursive: true, force: true })
    }
  })

  test('codex spawn surfaces the naming-style suggestion when the name uses the legacy `codex-` prefix', async () => {
    // The suggestion is informational; the `codex-` shape is not
    // reserved and is not on a removal path. Spawn must succeed
    // unchanged and the line must read as a tip, not a deprecation.
    const name = `codex-suggest-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    const registry = new EngineRegistry()
    registry.register(new CodexEngine({ binPath: FAKE_CODEX, readyTimeoutMs: 5000 }))
    const env = fakeEnv({ dispatcherDir, engines: registry })

    try {
      await reapDaemon(name)
      removeBaseRecord(name)
      const spawned = await runCli(['spawn', name, '--engine', 'codex'], env)
      expect(spawned.code).toBe(0)
      expect(spawned.stderr).toContain(`tm spawn: note — name '${name}' uses the legacy 'codex-' prefix`)
      expect(spawned.stderr).toContain(`the nested form 'codex/suggest-`)
      expect(spawned.stderr).toContain('Both shapes are supported')
      // No removal promise — anything stating a future hard error /
      // deprecation would walk back the ADR's "name is a label" rule.
      expect(spawned.stderr).not.toContain('hard error')
      expect(spawned.stderr).not.toContain('deprecat')
      // Behaviour unchanged: identity recorded as codex, daemon spawned.
      expect(readIdentity(name)).toMatchObject({ name, engine: 'codex' })
    } finally {
      await reapDaemon(name)
      removeBaseRecord(name)
      rmSync(dispatcherDir, { recursive: true, force: true })
    }
  })

  test('codex spawn does not warn for nested `codex/...` names', async () => {
    const name = `codex/nested-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    const registry = new EngineRegistry()
    registry.register(new CodexEngine({ binPath: FAKE_CODEX, readyTimeoutMs: 5000 }))
    const env = fakeEnv({ dispatcherDir, engines: registry })

    try {
      await reapDaemon(name)
      removeBaseRecord(name)
      const spawned = await runCli(['spawn', name, '--engine', 'codex'], env)
      expect(spawned.code).toBe(0)
      expect(spawned.stderr).not.toContain('legacy')
      expect(spawned.stderr).not.toContain('deprecat')
    } finally {
      await reapDaemon(name)
      removeBaseRecord(name)
      rmSync(dispatcherDir, { recursive: true, force: true })
    }
  })

  test('claude spawn does not warn when the name happens to start with `codex-`', async () => {
    // The warning is engine-scoped: a claude teammate with a `codex-` name
    // is just an arbitrary label, not a misrouted codex teammate.
    const repo = `codex-claude-only-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    mkdirSync(join(dispatcherDir, repo), { recursive: true })
    const runTmux: TmuxRunner = async () => ({ code: 0, stdout: '', stderr: '' })
    const env = fakeEnv({ dispatcherDir, runTmux })

    try {
      const spawned = await runCli(['spawn', repo, '--engine', 'claude'], env)
      expect(spawned.stderr).not.toContain('legacy')
      expect(spawned.stderr).not.toContain('deprecat')
    } finally {
      rmSync(dispatcherDir, { recursive: true, force: true })
    }
  })

  test('resume warns when routing a codex teammate whose name uses the legacy `codex-` prefix', async () => {
    const name = `codex-resume-suggest-${Date.now()}`
    writeBaseRecord(new CodexTeammateRecord({
      name,
      repo: '/tmp',
      cwd: '/tmp',
      worktreeSlug: null,
      createdAt: 1,
      displayName: null,
    }))
    const registry = new EngineRegistry()
    const fakeCodex = {
      kind: 'codex',
      resume: async () => ({ kind: 'resumed', checkpoint: '019e5f5f-2e57-7abc-8def-123456789ac7' }),
    } as unknown as Engine
    registry.register(fakeCodex)

    try {
      const result = await runCli(['resume', name], fakeEnv({ engines: registry }))
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('resumed: 019e5f5f-2e57-7abc-8def-123456789ac7\n')
      expect(result.stderr).toContain(`tm resume: note — name '${name}' uses the legacy 'codex-' prefix`)
      expect(result.stderr).toContain('Both shapes are supported')
      expect(result.stderr).not.toContain('hard error')
      expect(result.stderr).not.toContain('deprecat')
    } finally {
      removeBaseRecord(name)
    }
  })

  test('claude spawn writes the base identity record for identity-router follow-up verbs', async () => {
    const repo = `claude-router-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    mkdirSync(join(dispatcherDir, repo), { recursive: true })
    const liveSessions = new Set<string>()
    const runTmux: TmuxRunner = async (args) => {
      if (args[0] === 'has-session') {
        const target = args[2]?.replace(/^=/, '') ?? ''
        return { code: liveSessions.has(target) ? 0 : 1, stdout: '', stderr: '' }
      }
      if (args[0] === 'new-session') {
        const session = args[args.indexOf('-s') + 1] ?? ''
        liveSessions.add(session)
        mkdirSync(dirname(readyFile(repo)), { recursive: true })
        writeFileSync(readyFile(repo), '')
        return { code: 0, stdout: '%1\n', stderr: '' }
      }
      if (args[0] === 'send-keys') return { code: 0, stdout: '', stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }

    try {
      const result = await runCli(['spawn', repo], fakeEnv({ dispatcherDir, runTmux }))
      expect(result.code).toBe(0)
      expect(readIdentity(repo)).toMatchObject({
        name: repo,
        engine: 'claude',
        cwd: realpathSync(join(dispatcherDir, repo)),
      })
    } finally {
      rmSync(dispatcherDir, { recursive: true, force: true })
      rmSync(cwdFile(repo), { force: true })
      rmSync(sidFile(repo), { force: true })
      rmSync(readyFile(repo), { force: true })
      rmSync(sendAtFile(repo), { force: true })
      removeBaseRecord(repo)
    }
  })

  test('a live pre-identity claude tmux teammate is migrated before routing', async () => {
    const name = `legacy-claude-${Date.now()}`
    const cwd = mkdtempSync('/tmp/cmxcli-legacy-cwd-')
    mkdirSync(dirname(cwdFile(name)), { recursive: true })
    writeFileSync(cwdFile(name), `${cwd}\n`)
    const registry = new EngineRegistry()
    registry.register({
      kind: 'claude',
      send: async (req: { name: string }) => ({
        kind: 'completed',
        text: `sent to ${req.name}\n`,
        items: [],
        context: null,
      }),
    } as unknown as Engine)
    const runTmux: TmuxRunner = async (args) => {
      if (args[0] === 'has-session' && args[2] === `=teammate-${name}`) {
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 1, stdout: '', stderr: '' }
    }

    try {
      const result = await runCli(
        ['send', name, '--prompt', 'hi'],
        fakeEnv({ engines: registry, runTmux }),
      )
      expect(result).toEqual({ code: 0, stdout: `sent to ${name}\n`, stderr: '' })
      expect(readIdentity(name)).toMatchObject({
        name,
        engine: 'claude',
        cwd: realpathSync(cwd),
      })
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(cwdFile(name), { force: true })
      removeBaseRecord(name)
    }
  })

  test('codex send and wait keep omitted timeouts unbounded and preserve explicit timeouts', async () => {
    const seenSend: Array<number | null> = []
    const seenWait: Array<number | null> = []
    const fakeCodex = {
      kind: 'codex',
      send: async (req: { timeoutMs: number | null }) => {
        seenSend.push(req.timeoutMs)
        return { kind: 'completed', text: 'ok\n', items: [], context: null }
      },
      wait: async (req: { timeoutMs: number | null }) => {
        seenWait.push(req.timeoutMs)
        return { kind: 'no-op', reason: 'captured timeout' }
      },
    } as unknown as Engine
    const registry = new EngineRegistry()
    registry.register(fakeCodex)
    const env = fakeEnv({ engines: registry })

    writeBaseRecord(new CodexTeammateRecord({
      name: 'codex-timeout',
      repo: '/tmp',
      cwd: '/tmp',
      worktreeSlug: null,
      createdAt: 1,
      displayName: null,
    }))
    try {
      expect((await runCli(['send', 'codex-timeout', '--prompt', 'hi'], env)).code).toBe(0)
      expect((await runCli(['send', 'codex-timeout', '--prompt', 'hi', '--timeout', '7'], env)).code).toBe(0)
      expect((await runCli(['wait', 'codex-timeout'], env)).code).toBe(0)
      expect((await runCli(['wait', 'codex-timeout', '--timeout', '7'], env)).code).toBe(0)

      expect(seenSend).toEqual([null, 7000])
      expect(seenWait).toEqual([null, 7000])
    } finally {
      removeBaseRecord('codex-timeout')
    }
  })

  test('ctx --all fans out through engine listings, including codex teammates', async () => {
    const seen: string[] = []
    const fakeClaude = {
      kind: 'claude',
      list: async () => [{
        name: 'claude-fleet',
        engine: 'claude',
        state: 'idle',
        cwd: '/tmp/claude-fleet',
        displayName: null,
        extras: {},
      }],
      ctx: async (req: { name: string }) => {
        seen.push(`claude:${req.name}`)
        return {
          kind: 'usage',
          tokensUsed: 10,
          tokensTotal: 200000,
          pct: 0,
          tmResult: { code: 0, stdout: `${req.name}: claude ctx\n`, stderr: '' },
        }
      },
    } as unknown as Engine
    const fakeCodex = {
      kind: 'codex',
      list: async () => [{
        name: 'codex-fleet',
        engine: 'codex',
        state: 'idle',
        cwd: '/tmp/codex-fleet',
        displayName: null,
        extras: {},
      }],
      ctx: async (req: { name: string }) => {
        seen.push(`codex:${req.name}`)
        return {
          kind: 'usage',
          tokensUsed: 20,
          tokensTotal: 200000,
          pct: 0,
          tmResult: { code: 0, stdout: `${req.name}: codex ctx\n`, stderr: '' },
        }
      },
    } as unknown as Engine
    const registry = new EngineRegistry()
    registry.register(fakeClaude)
    registry.register(fakeCodex)

    const result = await runCli(['ctx', '--all'], fakeEnv({ engines: registry }))

    expect(result).toEqual({
      code: 0,
      stdout: 'claude-fleet: claude ctx\ncodex-fleet: codex ctx\n',
      stderr: '',
    })
    expect(seen).toEqual(['claude:claude-fleet', 'codex:codex-fleet'])
  })

  test('reload --all fans out through engine listings and reports codex not-supported', async () => {
    const seen: string[] = []
    const fakeClaude = {
      kind: 'claude',
      list: async () => [{
        name: 'claude-reload',
        engine: 'claude',
        state: 'idle',
        cwd: '/tmp/claude-reload',
        displayName: null,
        extras: {},
      }],
      reload: async (req: { name: string }) => {
        seen.push(`claude:${req.name}`)
        return {
          kind: 'reloaded',
          tmResult: { code: 0, stdout: `→ ${req.name}: /reload-plugins\n`, stderr: '' },
        }
      },
    } as unknown as Engine
    const fakeCodex = {
      kind: 'codex',
      list: async () => [{
        name: 'codex-reload',
        engine: 'codex',
        state: 'idle',
        cwd: '/tmp/codex-reload',
        displayName: null,
        extras: {},
      }],
      reload: async (req: { name: string }) => {
        seen.push(`codex:${req.name}`)
        return { kind: 'not-supported', reason: 'codex has no reload prompt command' }
      },
    } as unknown as Engine
    const registry = new EngineRegistry()
    registry.register(fakeClaude)
    registry.register(fakeCodex)

    const result = await runCli(['reload', '--all'], fakeEnv({ engines: registry }))

    expect(result).toEqual({
      code: 0,
      stdout: '→ claude-reload: /reload-plugins\n',
      stderr: '  not supported: codex has no reload prompt command\n',
    })
    expect(seen).toEqual(['claude:claude-reload', 'codex:codex-reload'])
  })

  test.each([
    ['compact', (name: string) => ['compact', name], 'codex compacts its own context automatically'],
    ['mem', (name: string) => ['mem', name], 'codex does not use Claude project memory files'],
    ['reload', (name: string) => ['reload', name], 'codex has no reload prompt command'],
  ])('%s routes an existing codex teammate through CodexEngine not-supported', async (_verb, argvFor, reason) => {
    const name = `codex-dispatch-${_verb}-${Date.now()}`
    writeBaseRecord(new CodexTeammateRecord({
      name,
      repo: '/tmp',
      cwd: '/tmp',
      worktreeSlug: null,
      createdAt: 1,
      displayName: null,
    }))
    const registry = new EngineRegistry()
    registry.register(new CodexEngine())

    try {
      const result = await runCli(argvFor(name), fakeEnv({ engines: registry }))
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(reason)
    } finally {
      removeBaseRecord(name)
    }
  })

  test('resume routes an existing codex teammate through CodexEngine with null checkpoint', async () => {
    const name = `cdx-dispatch-resume-${Date.now()}`
    writeBaseRecord(new CodexTeammateRecord({
      name,
      repo: '/tmp',
      cwd: '/tmp',
      worktreeSlug: null,
      createdAt: 1,
      displayName: null,
    }))
    const registry = new EngineRegistry()
    const seen: Array<{ name: string; cwd: string | null; checkpoint: string | null }> = []
    const fakeCodex = {
      kind: 'codex',
      resume: async (req: { name: string; cwd: string | null; checkpoint: string | null }) => {
        seen.push({ name: req.name, cwd: req.cwd, checkpoint: req.checkpoint })
        return { kind: 'resumed', checkpoint: '019e5f5f-2e57-7abc-8def-123456789ac7' }
      },
    } as unknown as Engine
    registry.register(fakeCodex)

    try {
      const result = await runCli(['resume', name], fakeEnv({ engines: registry }))
      expect(result).toEqual({
        code: 0,
        stdout: 'resumed: 019e5f5f-2e57-7abc-8def-123456789ac7\n',
        stderr: '',
      })
      expect(seen).toEqual([{ name, cwd: realpathSync('/tmp'), checkpoint: null }])
    } finally {
      removeBaseRecord(name)
    }
  })

  test('resume routes a killed non-prefix codex teammate by rollout thread id', async () => {
    const name = `resume-router-${Date.now()}`
    const threadId = '019e5f5f-2e57-7abc-8def-123456789abc'
    const sessionsRoot = mkdtempSync('/tmp/cmxcli-sessions-')
    const savedSessionsRoot = process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
    const seen: Array<{ name: string; cwd: string | null; checkpoint: string | null }> = []
    const fakeCodex = {
      kind: 'codex',
      resume: async (req: { name: string; cwd: string | null; checkpoint: string | null }) => {
        seen.push({ name: req.name, cwd: req.cwd, checkpoint: req.checkpoint })
        return { kind: 'resumed', checkpoint: req.checkpoint }
      },
    } as unknown as Engine
    const registry = new EngineRegistry()
    registry.register(fakeCodex)
    process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = sessionsRoot
    writeCliRollout(sessionsRoot, threadId)

    try {
      const result = await runCli(['resume', name, threadId], fakeEnv({ engines: registry }))
      expect(result).toEqual({ code: 0, stdout: `resumed: ${threadId}\n`, stderr: '' })
      expect(seen).toEqual([{ name, cwd: realpathSync('/tmp'), checkpoint: threadId }])
    } finally {
      if (savedSessionsRoot === undefined) delete process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
      else process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = savedSessionsRoot
      rmSync(sessionsRoot, { recursive: true, force: true })
    }
  })

  test('history routes a killed non-prefix codex teammate by rollout cwd', async () => {
    const name = `history-router-${Date.now()}`
    const threadId = '019e5f5f-2e57-7abc-8def-123456789ac1'
    const sessionsRoot = mkdtempSync('/tmp/cmxcli-sessions-')
    const savedSessionsRoot = process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
    const seen: Array<{ name: string; cwd: string | null; index: string | null }> = []
    const fakeCodex = {
      kind: 'codex',
      history: async (req: { name: string; cwd: string | null; index: string | null }) => {
        seen.push({ name: req.name, cwd: req.cwd, index: req.index })
        return {
          kind: 'list',
          turns: [],
          tmResult: { code: 0, stdout: 'codex history\n', stderr: '' },
        }
      },
    } as unknown as Engine
    const registry = new EngineRegistry()
    registry.register(fakeCodex)
    process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = sessionsRoot
    writeCliRollout(sessionsRoot, threadId)

    try {
      const result = await runCli(['history', name], fakeEnv({ engines: registry }))
      expect(result).toEqual({ code: 0, stdout: 'codex history\n', stderr: '' })
      expect(seen).toEqual([{ name, cwd: realpathSync('/tmp'), index: null }])
    } finally {
      if (savedSessionsRoot === undefined) delete process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
      else process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = savedSessionsRoot
      rmSync(sessionsRoot, { recursive: true, force: true })
    }
  })

  test('history routes a killed non-prefix codex teammate by realpath-matched rollout cwd', async () => {
    const name = `history-router-link-${Date.now()}`
    const threadId = '019e5f5f-2e57-7abc-8def-123456789ac4'
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    const realRepo = mkdtempSync('/tmp/cmxcli-real-repo-')
    const repoLink = join(dispatcherDir, name)
    const sessionsRoot = mkdtempSync('/tmp/cmxcli-sessions-')
    const savedSessionsRoot = process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
    const seen: Array<{ name: string; cwd: string | null; index: string | null }> = []
    const fakeCodex = {
      kind: 'codex',
      history: async (req: { name: string; cwd: string | null; index: string | null }) => {
        seen.push({ name: req.name, cwd: req.cwd, index: req.index })
        return {
          kind: 'list',
          turns: [],
          tmResult: { code: 0, stdout: 'codex history via realpath\n', stderr: '' },
        }
      },
    } as unknown as Engine
    const registry = new EngineRegistry()
    registry.register(fakeCodex)
    process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = sessionsRoot
    symlinkSync(realRepo, repoLink)
    writeCliRollout(sessionsRoot, threadId, repoLink)

    try {
      const result = await runCli(['history', name], fakeEnv({ dispatcherDir, engines: registry }))
      expect(result).toEqual({ code: 0, stdout: 'codex history via realpath\n', stderr: '' })
      expect(seen).toEqual([{ name, cwd: realpathSync(realRepo), index: null }])
    } finally {
      if (savedSessionsRoot === undefined) delete process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
      else process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = savedSessionsRoot
      rmSync(dispatcherDir, { recursive: true, force: true })
      rmSync(realRepo, { recursive: true, force: true })
      rmSync(sessionsRoot, { recursive: true, force: true })
    }
  })

  test('history for an existing codex teammate uses the recorded cwd across dispatcher dirs', async () => {
    const name = `history-cross-dispatcher-${Date.now()}`
    const originalCwd = mkdtempSync('/tmp/cmxcli-codex-cwd-')
    const otherDispatcher = mkdtempSync('/tmp/cmxcli-other-dispatcher-')
    const seen: Array<{ name: string; cwd: string | null; index: string | null }> = []
    const fakeCodex = {
      kind: 'codex',
      history: async (req: { name: string; cwd: string | null; index: string | null }) => {
        seen.push({ name: req.name, cwd: req.cwd, index: req.index })
        return {
          kind: 'list',
          turns: [],
          tmResult: { code: 0, stdout: 'codex history from base cwd\n', stderr: '' },
        }
      },
    } as unknown as Engine
    const registry = new EngineRegistry()
    registry.register(fakeCodex)
    writeBaseRecord(new CodexTeammateRecord({
      name,
      repo: originalCwd,
      cwd: originalCwd,
      worktreeSlug: null,
      createdAt: 1,
      displayName: null,
    }))

    try {
      const result = await runCli(
        ['history', name],
        fakeEnv({ dispatcherDir: otherDispatcher, engines: registry }),
      )
      expect(result).toEqual({ code: 0, stdout: 'codex history from base cwd\n', stderr: '' })
      expect(seen).toEqual([{ name, cwd: realpathSync(originalCwd), index: null }])
    } finally {
      removeBaseRecord(name)
      rmSync(originalCwd, { recursive: true, force: true })
      rmSync(otherDispatcher, { recursive: true, force: true })
    }
  })

  // ─── U7: history detail-mode prefix short-circuit ──────────────────
  // Once the UUID version digit is exposed by the prefix (the 13th hex
  // char with `-` stripped), the verb knows exactly one engine can hold
  // a matching session — claude for v4, codex for v7. Probing the other
  // engine would walk a session tree it cannot match. Short prefixes
  // (no version digit reached) keep the dual-engine probe.
  //
  // Each test asserts which engines were called by counting calls on a
  // fake claude + fake codex pair; the short-circuit asserts exactly
  // one was called, the dual probe asserts both were.

  test('history detail short-circuits to claude when prefix exposes a UUID v4 version digit', async () => {
    const repo = `history-shortcircuit-v4-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    mkdirSync(join(dispatcherDir, repo), { recursive: true })
    const claudeCalls: string[] = []
    const codexCalls: string[] = []
    const fakeClaude = {
      kind: 'claude',
      history: async (req: { name: string; index: string | null }) => {
        claudeCalls.push(req.index ?? '<null>')
        return {
          kind: 'list',
          turns: [{ index: 0, startedAt: 0, summary: 'claude detail' }],
          tmResult: { code: 0, stdout: 'claude detail\n', stderr: '' },
        }
      },
    } as unknown as Engine
    const fakeCodex = {
      kind: 'codex',
      history: async (req: { name: string; index: string | null }) => {
        codexCalls.push(req.index ?? '<null>')
        return {
          kind: 'failed' as const,
          message: 'should not be called',
        }
      },
    } as unknown as Engine
    const registry = new EngineRegistry()
    registry.register(fakeClaude)
    registry.register(fakeCodex)

    try {
      // 52778285-eab4-4 — 15 chars, strip-dashes index 12 is '4' (v4 → claude)
      const prefix = '52778285-eab4-4'
      const result = await runCli(['history', repo, prefix], fakeEnv({ dispatcherDir, engines: registry }))
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('claude detail\n')
      expect(claudeCalls).toEqual([prefix])
      expect(codexCalls).toEqual([])
    } finally {
      rmSync(dispatcherDir, { recursive: true, force: true })
    }
  })

  test('history detail short-circuits to codex when prefix exposes a UUID v7 version digit', async () => {
    const repo = `history-shortcircuit-v7-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    mkdirSync(join(dispatcherDir, repo), { recursive: true })
    const claudeCalls: string[] = []
    const codexCalls: string[] = []
    const fakeClaude = {
      kind: 'claude',
      history: async (req: { name: string; index: string | null }) => {
        claudeCalls.push(req.index ?? '<null>')
        return {
          kind: 'failed' as const,
          message: 'should not be called',
        }
      },
    } as unknown as Engine
    const fakeCodex = {
      kind: 'codex',
      history: async (req: { name: string; index: string | null }) => {
        codexCalls.push(req.index ?? '<null>')
        return {
          kind: 'list',
          turns: [{ index: 0, startedAt: 0, summary: 'codex detail' }],
          tmResult: { code: 0, stdout: 'codex detail\n', stderr: '' },
        }
      },
    } as unknown as Engine
    const registry = new EngineRegistry()
    registry.register(fakeClaude)
    registry.register(fakeCodex)

    try {
      // 019e5794-8c6f-7 — 15 chars, strip-dashes index 12 is '7' (v7 → codex)
      const prefix = '019e5794-8c6f-7'
      const result = await runCli(['history', repo, prefix], fakeEnv({ dispatcherDir, engines: registry }))
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('codex detail\n')
      expect(codexCalls).toEqual([prefix])
      expect(claudeCalls).toEqual([])
    } finally {
      rmSync(dispatcherDir, { recursive: true, force: true })
    }
  })

  test('history detail falls back to dual probe when prefix is too short for the version digit', async () => {
    const repo = `history-shortcircuit-fallback-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmxcli-dispatcher-')
    mkdirSync(join(dispatcherDir, repo), { recursive: true })
    const claudeCalls: string[] = []
    const codexCalls: string[] = []
    const fakeClaude = {
      kind: 'claude',
      history: async (req: { name: string; index: string | null }) => {
        claudeCalls.push(req.index ?? '<null>')
        // Empty list → no match on claude side; codex's match wins.
        return {
          kind: 'failed' as const,
          message: `tm history: no session matching '${req.index}' in ${req.name}`,
        }
      },
    } as unknown as Engine
    const fakeCodex = {
      kind: 'codex',
      history: async (req: { name: string; index: string | null }) => {
        codexCalls.push(req.index ?? '<null>')
        return {
          kind: 'detail',
          turn: { index: 0, startedAt: 0, summary: req.index ?? '' },
          items: [],
          tmResult: { code: 0, stdout: 'codex detail (fallback)\n', stderr: '' },
        }
      },
    } as unknown as Engine
    const registry = new EngineRegistry()
    registry.register(fakeClaude)
    registry.register(fakeCodex)

    try {
      // 8 hex chars — strip length 8 < 13, version digit not reachable.
      const prefix = '52778285'
      const result = await runCli(['history', repo, prefix], fakeEnv({ dispatcherDir, engines: registry }))
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('codex detail (fallback)\n')
      // Both engines probed — that is the fallback path.
      expect(claudeCalls).toEqual([prefix])
      expect(codexCalls).toEqual([prefix])
    } finally {
      rmSync(dispatcherDir, { recursive: true, force: true })
    }
  })

  test('last routes an existing codex teammate through CodexEngine rollout lookup', async () => {
    const name = `codex-dispatch-last-${Date.now()}`
    writeBaseRecord(new CodexTeammateRecord({
      name,
      repo: '/tmp',
      cwd: '/tmp',
      worktreeSlug: null,
      createdAt: 1,
      displayName: null,
    }))
    const registry = new EngineRegistry()
    registry.register(new CodexEngine())

    try {
      const result = await runCli(['last', name], fakeEnv({ engines: registry }))
      expect(result).toEqual({
        code: 1,
        stdout: '',
        stderr: `tm: last: codex teammate '${name}' has no thread id\n`,
      })
    } finally {
      removeBaseRecord(name)
    }
  })

  test('ctx routes an existing codex teammate through CodexEngine rollout lookup', async () => {
    const name = `codex-dispatch-ctx-${Date.now()}`
    writeBaseRecord(new CodexTeammateRecord({
      name,
      repo: '/tmp',
      cwd: '/tmp',
      worktreeSlug: null,
      createdAt: 1,
      displayName: null,
    }))
    const registry = new EngineRegistry()
    registry.register(new CodexEngine())

    try {
      const result = await runCli(['ctx', name], fakeEnv({ engines: registry }))
      expect(result).toEqual({
        code: 0,
        stdout: '',
        stderr: `  not supported: codex teammate '${name}' has no thread id\n`,
      })
    } finally {
      removeBaseRecord(name)
    }
  })
})

describe.skip('resume engine-probing — no checkpoint + no base record', () => {
  // After `tm kill`, a non-prefix codex teammate's base record is gone and
  // the router returns null. The probing branch in `verbs/resume.ts` asks
  // both engines whether they hold history for the teammate's cwd, then:
  //   - routes the single candidate if exactly one matches,
  //   - refuses with an ambiguity error if both match,
  //   - errors with "no resumable session" if neither matches.
  // `--engine` is an unconditional override that bypasses the probe.

  type ResumeCall = { engine: 'claude' | 'codex'; name: string; cwd: string | null; checkpoint: string | null }

  // The default `fakeTmux` returns code 0 for everything, which would make
  // the live-teammate identity migrator materialise a Claude record and
  // short-circuit probing to the Claude engine. Probing exists for the
  // "no session, no record" case, so these tests must stub `has-session`
  // as missing (code 1).
  const noTmuxSession: TmuxRunner = async (args) =>
    args[0] === 'has-session'
      ? { code: 1, stdout: '', stderr: '' }
      : { code: 0, stdout: '', stderr: '' }

  function fakeResumeEngine(kind: 'claude' | 'codex', sink: ResumeCall[]): Engine {
    return {
      kind,
      resume: async (req: { name: string; cwd: string | null; checkpoint: string | null }) => {
        sink.push({ engine: kind, name: req.name, cwd: req.cwd, checkpoint: req.checkpoint })
        return { kind: 'resumed', checkpoint: req.checkpoint }
      },
    } as unknown as Engine
  }

  function setupProbeFixture(): {
    repo: string
    dispatcherDir: string
    projectsDir: string
    sessionsRoot: string
    repoRealpath: string
    sink: ResumeCall[]
    registry: EngineRegistry
    cleanup: () => void
  } {
    const repo = `probe-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    const dispatcherDir = mkdtempSync('/tmp/cmx-probe-disp-')
    const projectsDir = mkdtempSync('/tmp/cmx-probe-proj-')
    const sessionsRoot = mkdtempSync('/tmp/cmx-probe-sessions-')
    const savedSessionsRoot = process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
    process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = sessionsRoot
    const repoDir = join(dispatcherDir, repo)
    mkdirSync(repoDir, { recursive: true })
    const repoRealpath = realpathSync(repoDir)
    const sink: ResumeCall[] = []
    const registry = new EngineRegistry()
    registry.register(fakeResumeEngine('claude', sink))
    registry.register(fakeResumeEngine('codex', sink))
    return {
      repo,
      dispatcherDir,
      projectsDir,
      sessionsRoot,
      repoRealpath,
      sink,
      registry,
      cleanup: () => {
        if (savedSessionsRoot === undefined) delete process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT']
        else process.env['CLAUDEMUX_CODEX_SESSIONS_ROOT'] = savedSessionsRoot
        rmSync(dispatcherDir, { recursive: true, force: true })
        rmSync(projectsDir, { recursive: true, force: true })
        rmSync(sessionsRoot, { recursive: true, force: true })
      },
    }
  }

  function seedClaudeJsonl(projectsDir: string, cwd: string): void {
    const projectDir = join(projectsDir, encodeProjectDir(cwd))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'), '')
  }

  test('codex-only candidate auto-routes to codex', async () => {
    const f = setupProbeFixture()
    try {
      writeCliRollout(f.sessionsRoot, '019e5f5f-2e57-7abc-8def-aaaaaaaaaaa1', f.repoRealpath)
      const result = await runCli(
        ['resume', f.repo],
        fakeEnv({
          dispatcherDir: f.dispatcherDir,
          projectsDir: f.projectsDir,
          engines: f.registry,
          runTmux: noTmuxSession,
        }),
      )
      expect(result.code).toBe(0)
      expect(f.sink).toEqual([
        { engine: 'codex', name: f.repo, cwd: f.repoRealpath, checkpoint: null },
      ])
    } finally {
      f.cleanup()
    }
  })

  test('claude-only candidate auto-routes to claude', async () => {
    const f = setupProbeFixture()
    try {
      seedClaudeJsonl(f.projectsDir, f.repoRealpath)
      const result = await runCli(
        ['resume', f.repo],
        fakeEnv({
          dispatcherDir: f.dispatcherDir,
          projectsDir: f.projectsDir,
          engines: f.registry,
          runTmux: noTmuxSession,
        }),
      )
      expect(result.code).toBe(0)
      expect(f.sink).toEqual([
        { engine: 'claude', name: f.repo, cwd: f.repoRealpath, checkpoint: null },
      ])
    } finally {
      f.cleanup()
    }
  })

  test('both candidates → ambiguity error, dispatch reaches neither engine', async () => {
    const f = setupProbeFixture()
    try {
      writeCliRollout(f.sessionsRoot, '019e5f5f-2e57-7abc-8def-aaaaaaaaaaa2', f.repoRealpath)
      seedClaudeJsonl(f.projectsDir, f.repoRealpath)
      const result = await runCli(
        ['resume', f.repo],
        fakeEnv({
          dispatcherDir: f.dispatcherDir,
          projectsDir: f.projectsDir,
          engines: f.registry,
          runTmux: noTmuxSession,
        }),
      )
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('ambiguous')
      expect(result.stderr).toContain('--engine codex|claude')
      expect(result.stderr).toContain('<sid>')
      expect(result.stderr).toContain(f.repoRealpath)
      expect(f.sink).toEqual([])
    } finally {
      f.cleanup()
    }
  })

  test('neither candidate → no resumable session error', async () => {
    const f = setupProbeFixture()
    try {
      const result = await runCli(
        ['resume', f.repo],
        fakeEnv({
          dispatcherDir: f.dispatcherDir,
          projectsDir: f.projectsDir,
          engines: f.registry,
          runTmux: noTmuxSession,
        }),
      )
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`no resumable session for ${f.repo}`)
      expect(result.stderr).toContain(`cwd ${f.repoRealpath}`)
      expect(result.stderr).toContain('tm spawn')
      expect(f.sink).toEqual([])
    } finally {
      f.cleanup()
    }
  })

  test('--engine claude overrides probing even when only codex has history', async () => {
    const f = setupProbeFixture()
    try {
      writeCliRollout(f.sessionsRoot, '019e5f5f-2e57-7abc-8def-aaaaaaaaaaa3', f.repoRealpath)
      const result = await runCli(
        ['resume', f.repo, '--engine', 'claude'],
        fakeEnv({
          dispatcherDir: f.dispatcherDir,
          projectsDir: f.projectsDir,
          engines: f.registry,
          runTmux: noTmuxSession,
        }),
      )
      expect(result.code).toBe(0)
      expect(f.sink).toEqual([
        { engine: 'claude', name: f.repo, cwd: f.repoRealpath, checkpoint: null },
      ])
    } finally {
      f.cleanup()
    }
  })

  test('--engine codex overrides probing even when only claude has history', async () => {
    const f = setupProbeFixture()
    try {
      seedClaudeJsonl(f.projectsDir, f.repoRealpath)
      const result = await runCli(
        ['resume', f.repo, '--engine', 'codex'],
        fakeEnv({
          dispatcherDir: f.dispatcherDir,
          projectsDir: f.projectsDir,
          engines: f.registry,
          runTmux: noTmuxSession,
        }),
      )
      expect(result.code).toBe(0)
      expect(f.sink).toEqual([
        { engine: 'codex', name: f.repo, cwd: f.repoRealpath, checkpoint: null },
      ])
    } finally {
      f.cleanup()
    }
  })

  test('--engine wins even when both candidates exist (ambiguity bypass)', async () => {
    const f = setupProbeFixture()
    try {
      writeCliRollout(f.sessionsRoot, '019e5f5f-2e57-7abc-8def-aaaaaaaaaaa4', f.repoRealpath)
      seedClaudeJsonl(f.projectsDir, f.repoRealpath)
      const result = await runCli(
        ['resume', f.repo, '--engine=codex'],
        fakeEnv({
          dispatcherDir: f.dispatcherDir,
          projectsDir: f.projectsDir,
          engines: f.registry,
          runTmux: noTmuxSession,
        }),
      )
      expect(result.code).toBe(0)
      expect(f.sink).toEqual([
        { engine: 'codex', name: f.repo, cwd: f.repoRealpath, checkpoint: null },
      ])
    } finally {
      f.cleanup()
    }
  })

  test('--engine routes even when nothing else would (empty history)', async () => {
    const f = setupProbeFixture()
    try {
      // No rollout, no claude jsonl — probing alone would say "no resumable
      // session". An explicit --engine bypasses probing and hands the
      // engine a null checkpoint to do as it pleases (`claude --continue`
      // for claude; `thread/list(limit=1)` for codex).
      const result = await runCli(
        ['resume', f.repo, '--engine', 'claude'],
        fakeEnv({
          dispatcherDir: f.dispatcherDir,
          projectsDir: f.projectsDir,
          engines: f.registry,
          runTmux: noTmuxSession,
        }),
      )
      expect(result.code).toBe(0)
      expect(f.sink).toEqual([
        { engine: 'claude', name: f.repo, cwd: f.repoRealpath, checkpoint: null },
      ])
    } finally {
      f.cleanup()
    }
  })

  test('checkpoint reverse-lookup beats router and probing (existing behavior preserved)', async () => {
    const f = setupProbeFixture()
    try {
      // Both engines have probable history AND a codex thread-id is passed
      // — the checkpoint reverse-lookup path takes precedence over the
      // probing branch, so the ambiguity error never fires. This pins the
      // documented priority ordering: --engine > checkpoint > router > probing.
      const threadId = '019e5f5f-2e57-7abc-8def-aaaaaaaaaaa5'
      writeCliRollout(f.sessionsRoot, threadId, f.repoRealpath)
      seedClaudeJsonl(f.projectsDir, f.repoRealpath)
      const result = await runCli(
        ['resume', f.repo, threadId],
        fakeEnv({
          dispatcherDir: f.dispatcherDir,
          projectsDir: f.projectsDir,
          engines: f.registry,
          runTmux: noTmuxSession,
        }),
      )
      expect(result.code).toBe(0)
      expect(f.sink).toEqual([
        { engine: 'codex', name: f.repo, cwd: f.repoRealpath, checkpoint: threadId },
      ])
    } finally {
      f.cleanup()
    }
  })

  test('--engine with unregistered engine fails loudly', async () => {
    // Only the codex engine is registered — `--engine claude` finds no
    // entry in the registry and the verb returns a clean error rather than
    // crashing on a null deref.
    const repo = `probe-no-claude-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmx-probe-disp-')
    mkdirSync(join(dispatcherDir, repo), { recursive: true })
    const registry = new EngineRegistry()
    registry.register(fakeResumeEngine('codex', []))
    try {
      const result = await runCli(
        ['resume', repo, '--engine', 'claude'],
        fakeEnv({ dispatcherDir, engines: registry, runTmux: noTmuxSession }),
      )
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('--engine claude is not registered')
    } finally {
      rmSync(dispatcherDir, { recursive: true, force: true })
    }
  })

  test('--engine requires a value (bare flag dies with usage)', async () => {
    const result = await runCli(['resume', 'repo', '--engine'], fakeEnv())
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--engine requires a value')
  })

  test('--engine rejects values outside {claude, codex}', async () => {
    const result = await runCli(['resume', 'repo', '--engine', 'gpt'], fakeEnv())
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("--engine must be 'claude' or 'codex'")
  })

  test('non-probeable cwd skips probing and falls through to Claude default routing', async () => {
    // No base record, no codex meta, no repo dir → `codexCwd` falls back
    // to the dispatcher dir's realpath. The CLI parser flags cwdProbeable=false
    // for that case so the probing branch cannot match the dispatcher's
    // own transcripts. With no router resolution either, the compatibility
    // default routes to Claude without consulting transcript probes.
    const repo = `noproberepo-${Date.now()}`
    const dispatcherDir = mkdtempSync('/tmp/cmx-probe-noprobe-')
    // Seed Claude transcripts UNDER the dispatcher's encoded path so the
    // dispatcher-fallback cwd WOULD probe-match — this asserts the
    // cwdProbeable guard actually fires.
    const projectsDir = mkdtempSync('/tmp/cmx-probe-proj-')
    const dispatcherRealpath = realpathSync(dispatcherDir)
    const dispatcherProjectDir = join(projectsDir, encodeProjectDir(dispatcherRealpath))
    mkdirSync(dispatcherProjectDir, { recursive: true })
    writeFileSync(join(dispatcherProjectDir, 'oops.jsonl'), '')

    const sink: ResumeCall[] = []
    const registry = new EngineRegistry()
    registry.register(fakeResumeEngine('claude', sink))
    registry.register(fakeResumeEngine('codex', sink))

    try {
      const result = await runCli(
        ['resume', repo],
        fakeEnv({ dispatcherDir, projectsDir, engines: registry, runTmux: noTmuxSession }),
      )
      expect(result.code).toBe(0)
      expect(sink).toEqual([
        { engine: 'claude', name: repo, cwd: dispatcherRealpath, checkpoint: null },
      ])
    } finally {
      rmSync(dispatcherDir, { recursive: true, force: true })
      rmSync(projectsDir, { recursive: true, force: true })
    }
  })
})

describe.skip('engine-routed verbs (Phase 2a-1 fleet visibility)', () => {
  // Decision multi-engine-tui-architecture §"Fleet-visibility verbs" routes `tm ls` / `tm states` /
  // `tm status` through `EngineRegistry` instead of straight to tmux. The
  // tests here cover the dispatch wiring; per-engine output shape is
  // covered by ClaudeEngine's own unit tests + the conformance file
  // (which is updated when Phase 2a-2 inlines the verb bodies).
  //
  // `tm kill` now joins this set because Phase 2b registers CodexEngine and
  // codex spawn writes the base identity record the router needs.

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

describe.skip('doctor — sections fire top-down, never raising', () => {
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
    expect(result.stdout).toMatch(/codex teammates:\s*\n  \(none — use 'tm spawn <name> --engine codex' to launch one\)/)
  })

  test('reaping a dead codex daemon also removes its base identity record', async () => {
    const name = `codex-dead-${Date.now()}`
    mkdirSync(codexTeammateDir(name), { recursive: true })
    writeFileSync(codexPidFile(name), '0\n')
    writeFileSync(codexStartedAtFile(name), `${Math.floor(Date.now() / 1000)}\n`)
    writeBaseRecord(new CodexTeammateRecord({
      name,
      repo: '/tmp',
      cwd: '/tmp',
      worktreeSlug: null,
      createdAt: 1,
      displayName: null,
    }))

    const result = await runCli(['doctor'], fakeEnv())

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('reaped orphans')
    expect(readIdentity(name)).toBeNull()
    expect(existsSync(codexTeammateDir(name))).toBe(false)
  })

  test('the reported tm executable path is the production launcher', async () => {
    // Doctor's job is to tell the user which `tm` actually runs. Pin that
    // the reported path is the user-facing launcher at
    // `<plugin-root>/bin/tm`, never anything beneath `core/`.
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
