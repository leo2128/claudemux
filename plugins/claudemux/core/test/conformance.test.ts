/**
 * The Phase B conformance harness.
 *
 * Phase B migrates `tm` verbs into native core code (`src/native.ts`). The
 * migration is required to be *behavior-preserving*: a migrated verb must
 * produce exactly what `tm <verb>` produced
 * (`.agents/domains/mcp-native-orchestrator.md` §12). This is the differential
 * test that pins that — for each migrated verb and a set of fixture
 * scenarios, it runs the real `bin/tm` and the native handler against the
 * *same* fixture and asserts their `{code, stdout, stderr}` are identical.
 *
 * The oracle is the live `tm`, not a golden file: the spec's contract is
 * "`tm`'s current behavior", so the harness re-derives it on every run.
 *
 * Determinism without the real backends:
 *  - tmux — a fake `tmux` (`fixtures/fake-tmux-bin/tmux`) returns a
 *    test-controlled session list. `tm` reaches it through `PATH`; the native
 *    side through `CLAUDEMUX_TMUX`. Both reach the *same* script, so the two
 *    sides of the diff see identical tmux output. The `claudemux-core` CI job
 *    installs no tmux, so a fake is mandatory, not just convenient.
 *  - the `/tmp` marker files — written under their real `/tmp` paths (`tm`
 *    hardcodes them and cannot be redirected) but with UUID-unique repo/sid
 *    names, so a run cannot collide with a real teammate. Cleaned up per test.
 *
 * Scope: this pins a *verb handler*'s logic against the matching `cmd_<verb>`
 * in `tm`. The dispatch around it — `tm`'s `main` help pre-scan, the core's
 * native-vs-shell-out routing — is `core.ts`'s job and is covered by
 * `core.test.ts`, so the scenarios here never pass `--help`.
 *
 * Adding the next migrated verb is: append a `{ verb, scenarios }` entry to
 * `CONFORMANCE` below.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NATIVE_VERBS } from '../src/native'
import { idleDir, lastFileFor, sidFile } from '../src/paths'
import type { TmResult } from '../src/tm'
import { runTmux } from '../src/tmux'

/** The real `tm` — `core/test` → `core` → `claudemux` → `bin/tm`. */
const TM_BIN = join(import.meta.dir, '..', '..', 'bin', 'tm')
/** The fake `tmux` dir — prepended to `PATH` it shadows any real tmux. */
const FAKE_TMUX_DIR = join(import.meta.dir, 'fixtures', 'fake-tmux-bin')
const FAKE_TMUX = join(FAKE_TMUX_DIR, 'tmux')

/** Where the fake `tmux` reads its session list — one file, rewritten per test. */
let sessionsFile = ''
/** A scratch dir for the harness's own files. */
let scratchDir = ''
/** `/tmp` marker files a scenario wrote — removed after that scenario. */
const tmpFiles: string[] = []
/** Env values saved on entry, restored after the file so nothing leaks. */
let savedTmux: string | undefined
let savedSessions: string | undefined

beforeAll(() => {
  // Save the env first, before anything that can throw — `bun test` shares
  // one process across files, so `afterAll` must restore the real values
  // even if setup fails partway, or a stale `delete` leaks to later files.
  savedTmux = process.env.CLAUDEMUX_TMUX
  savedSessions = process.env.FAKE_TMUX_SESSIONS

  scratchDir = mkdtempSync(join(tmpdir(), 'claudemux-conf-'))
  sessionsFile = join(scratchDir, 'tmux-sessions')
  writeFileSync(sessionsFile, '')
  mkdirSync(idleDir(), { recursive: true })

  // Point the native `runTmux` at the same fake `tmux` the `tm` subprocess
  // reaches through `PATH`, reading the same session list.
  process.env.CLAUDEMUX_TMUX = FAKE_TMUX
  process.env.FAKE_TMUX_SESSIONS = sessionsFile
})

afterAll(() => {
  if (savedTmux === undefined) delete process.env.CLAUDEMUX_TMUX
  else process.env.CLAUDEMUX_TMUX = savedTmux
  if (savedSessions === undefined) delete process.env.FAKE_TMUX_SESSIONS
  else process.env.FAKE_TMUX_SESSIONS = savedSessions
  if (scratchDir && existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true })
})

afterEach(() => {
  for (const file of tmpFiles.splice(0)) {
    if (existsSync(file)) rmSync(file, { force: true })
  }
})

/** Run the real `tm` against the fixture; capture its faithful `TmResult`. */
async function realTm(verb: string, args: readonly string[], stdin?: string): Promise<TmResult> {
  const proc = Bun.spawn([TM_BIN, verb, ...args], {
    cwd: import.meta.dir,
    env: { ...process.env, PATH: `${FAKE_TMUX_DIR}:${process.env.PATH ?? ''}` },
    stdin: stdin != null ? new TextEncoder().encode(stdin) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

/** Run the native handler for the same verb against the same fixture. */
function runNative(verb: string, args: readonly string[], stdin?: string): Promise<TmResult> {
  const handler = NATIVE_VERBS[verb]
  if (!handler) throw new Error(`no native handler for ${verb}`)
  return handler(args, stdin != null ? { stdin } : undefined, { runTmux })
}

/** Write a `/tmp` marker file and remember it for cleanup. */
function marker(path: string, content: string): void {
  writeFileSync(path, content)
  tmpFiles.push(path)
}

/** Set the session list the fake `tmux ls` returns. */
function setSessions(text: string): void {
  writeFileSync(sessionsFile, text)
}

/** A test repo/sid name that cannot collide with a real teammate. */
function uniqueName(): string {
  return `claudemux-conftest-${randomUUID().slice(0, 12)}`
}

/** One conformance scenario: prepare the fixture, return the verb args. */
interface Scenario {
  name: string
  setup: () => { args: string[]; stdin?: string }
}

const CONFORMANCE: { verb: string; scenarios: Scenario[] }[] = [
  {
    verb: 'ls',
    scenarios: [
      {
        name: 'no sessions at all → the "no teammate sessions" line',
        setup: () => {
          setSessions('')
          return { args: [] }
        },
      },
      {
        name: 'only teammate sessions → every line kept',
        setup: () => {
          setSessions(
            'teammate-alpha: 1 windows (created Wed)\nteammate-beta: 2 windows (created Thu)\n',
          )
          return { args: [] }
        },
      },
      {
        name: 'teammate and non-teammate sessions → non-teammate dropped',
        setup: () => {
          setSessions('teammate-alpha: 1 windows\nnotes: 1 windows\nteammate-beta: 3 windows\n')
          return { args: [] }
        },
      },
      {
        name: 'a line with no colon is dropped, like awk -F:',
        setup: () => {
          setSessions('teammate-x: 1 windows\nmalformed-no-colon\n')
          return { args: [] }
        },
      },
      {
        name: 'only non-teammate sessions → the "no teammate sessions" line',
        setup: () => {
          setSessions('work: 1 windows\nnotes: 2 windows\n')
          return { args: [] }
        },
      },
    ],
  },
  {
    verb: 'last',
    scenarios: [
      {
        name: 'sid and .last present → the reply is printed verbatim',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          marker(sidFile(repo), `${sid}\n`)
          marker(lastFileFor(sid), 'the saved reply\nspanning two lines\n')
          return { args: [repo] }
        },
      },
      {
        name: 'no repo argument → the usage error',
        setup: () => ({ args: [] }),
      },
      {
        name: 'no sid file → the "no sid file" error',
        setup: () => ({ args: [uniqueName()] }),
      },
      {
        name: 'empty sid file → the "no sid file" error',
        setup: () => {
          const repo = uniqueName()
          marker(sidFile(repo), '')
          return { args: [repo] }
        },
      },
      {
        name: 'sid present but no .last file → the "no reply yet" error',
        setup: () => {
          const repo = uniqueName()
          marker(sidFile(repo), `${uniqueName()}\n`)
          return { args: [repo] }
        },
      },
      {
        name: 'empty .last file → the "no reply yet" error',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          marker(sidFile(repo), `${sid}\n`)
          marker(lastFileFor(sid), '')
          return { args: [repo] }
        },
      },
    ],
  },
]

for (const { verb, scenarios } of CONFORMANCE) {
  describe(`${verb} — native conforms to tm`, () => {
    for (const scenario of scenarios) {
      test(scenario.name, async () => {
        const { args, stdin } = scenario.setup()
        const oracle = await realTm(verb, args, stdin)
        const native = await runNative(verb, args, stdin)
        expect(native).toEqual(oracle)
      })
    }
  })
}
