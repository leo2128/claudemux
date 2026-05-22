/**
 * The Phase B conformance harness.
 *
 * Phase B migrates `tm` verbs into native core code (`src/native.ts`). The
 * migration is required to be *behavior-preserving*: a migrated verb must
 * produce exactly what `tm <verb>` produced
 * (`.agents/domains/mcp-native-orchestrator.md` §12). This is the differential
 * test that pins that — for each migrated verb and a set of fixture
 * scenarios, it runs the real `bin/tm` and the native handler against the
 * *same* fixture and asserts their `TmResult` values are equal: the exit
 * code, and stdout/stderr as strings decoded from UTF-8 (the `last` suite has
 * a CJK scenario that pins multibyte content surviving both paths intact).
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
 *  - the dispatcher dir and `~/.claude/projects` — sandboxed under a scratch
 *    dir. `tm` is pointed at them with `TM_DISPATCHER_DIR` / `HOME` in its
 *    spawn env; the native side with the injected `dispatcherDir` /
 *    `projectsDir`. (`ctx` needs `jq` for the `tm` side; CI installs it.)
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
import { cwdFile, encodeProjectDir, idleDir, lastFileFor, sidFile } from '../src/paths'
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
/** The sandbox dispatcher dir — `tm`'s `TM_DISPATCHER_DIR`, the core's `dispatcherDir`. */
let dispatcherDir = ''
/** The sandbox `~/.claude/projects` — under the sandbox `HOME`. */
let projectsDir = ''
/** The sandbox `HOME` — what `tm` resolves `~/.claude/projects` against. */
let sandboxHome = ''
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
  dispatcherDir = join(scratchDir, 'dispatcher')
  sandboxHome = join(scratchDir, 'home')
  projectsDir = join(sandboxHome, '.claude', 'projects')
  mkdirSync(projectsDir, { recursive: true })
  mkdirSync(dispatcherDir, { recursive: true })
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
    env: {
      ...process.env,
      PATH: `${FAKE_TMUX_DIR}:${process.env.PATH ?? ''}`,
      HOME: sandboxHome,
      TM_DISPATCHER_DIR: dispatcherDir,
    },
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
  return handler(args, stdin != null ? { stdin } : undefined, {
    runTmux,
    dispatcherDir,
    projectsDir,
  })
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

/** The cwd a teammate with no recorded `.cwd` file resolves to. */
function defaultCwd(repo: string): string {
  return `${dispatcherDir}/${repo}`
}

/** One assistant transcript line carrying a `message.usage` token block. */
function usageLine(input: number, cacheCreation: number, cacheRead: number, output: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
      },
    },
  })
}

/** Write a teammate's transcript jsonl under the sandbox projects dir. */
function writeTranscript(cwd: string, sid: string, lines: string[]): void {
  const dir = join(projectsDir, encodeProjectDir(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sid}.jsonl`), lines.length > 0 ? `${lines.join('\n')}\n` : '')
}

/** One conformance scenario: prepare the fixture, return the verb args. */
interface Scenario {
  name: string
  setup: () => { args: string[]; stdin?: string }
}

/** An `ls`/`ctx`-style teammate session line for the fake `tmux ls`. */
function sessionLine(repo: string): string {
  return `teammate-${repo}: 1 windows (created Wed)`
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
        name: 'a .last with CJK / multibyte content survives both paths intact',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          marker(sidFile(repo), `${sid}\n`)
          marker(lastFileFor(sid), '已完成中文回复\n第二行:emoji 🚀 也要原样回来\n')
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
  {
    verb: 'ctx',
    scenarios: [
      {
        name: 'usage present, peak under 210k → the "assumed 200k" line',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          marker(sidFile(repo), `${sid}\n`)
          writeTranscript(defaultCwd(repo), sid, [
            usageLine(100, 0, 0, 50),
            usageLine(1000, 2000, 3000, 500),
          ])
          return { args: [repo] }
        },
      },
      {
        name: 'a peak above 210k → the "detected 1M" window',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          marker(sidFile(repo), `${sid}\n`)
          writeTranscript(defaultCwd(repo), sid, [usageLine(250000, 0, 0, 1000)])
          return { args: [repo] }
        },
      },
      {
        name: '--window 1m forces the 1M window regardless of peak',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          marker(sidFile(repo), `${sid}\n`)
          writeTranscript(defaultCwd(repo), sid, [usageLine(5000, 0, 0, 100)])
          return { args: ['--window', '1m', repo] }
        },
      },
      {
        name: '--window=200k (the = form) is honored',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          marker(sidFile(repo), `${sid}\n`)
          writeTranscript(defaultCwd(repo), sid, [usageLine(300000, 0, 0, 100)])
          return { args: [`--window=200k`, repo] }
        },
      },
      {
        name: 'an invalid --window value → the validation error',
        setup: () => ({ args: ['--window', 'bad', uniqueName()] }),
      },
      {
        name: 'an unknown flag → the unknown-flag error',
        setup: () => ({ args: ['--bogus', uniqueName()] }),
      },
      {
        name: 'a bare --window with no value → tm exits 1 with no output',
        setup: () => ({ args: ['--window'] }),
      },
      {
        name: 'no arguments → the usage error',
        setup: () => ({ args: [] }),
      },
      {
        name: '--all with no running teammates → the usage error',
        setup: () => {
          setSessions('')
          return { args: ['--all'] }
        },
      },
      {
        name: '--all fans out across every running teammate, in tmux order',
        setup: () => {
          const repoA = uniqueName()
          const repoB = uniqueName()
          setSessions(`${sessionLine(repoA)}\n${sessionLine(repoB)}\n`)
          for (const repo of [repoA, repoB]) {
            const sid = uniqueName()
            marker(sidFile(repo), `${sid}\n`)
            writeTranscript(defaultCwd(repo), sid, [usageLine(4000, 0, 0, 80)])
          }
          return { args: ['--all'] }
        },
      },
      {
        name: 'no sid file → the "? (no sid file)" diagnostic',
        setup: () => ({ args: [uniqueName()] }),
      },
      {
        name: 'sid present but no transcript → the "? (no transcript)" diagnostic',
        setup: () => {
          const repo = uniqueName()
          marker(sidFile(repo), `${uniqueName()}\n`)
          return { args: [repo] }
        },
      },
      {
        name: 'a transcript with no assistant usage → the "? (no usage)" diagnostic',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          marker(sidFile(repo), `${sid}\n`)
          writeTranscript(defaultCwd(repo), sid, [
            JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
          ])
          return { args: [repo] }
        },
      },
      {
        name: 'a non-object transcript line fails the file, as jq does',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          marker(sidFile(repo), `${sid}\n`)
          // A bare `42` line: `jq -s` errors indexing it, failing the whole
          // pass — the native parse must fail the file too, not skip the line.
          writeTranscript(defaultCwd(repo), sid, ['42', usageLine(5000, 0, 0, 100)])
          return { args: [repo] }
        },
      },
      {
        name: 'a directory at the transcript path → the "no transcript" diagnostic',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          marker(sidFile(repo), `${sid}\n`)
          // `[[ -f ]]` is false for a directory; the native check must agree.
          mkdirSync(join(projectsDir, encodeProjectDir(defaultCwd(repo)), `${sid}.jsonl`), {
            recursive: true,
          })
          return { args: [repo] }
        },
      },
      {
        name: 'a recorded .cwd file relocates where the transcript is read',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          const recordedCwd = `${dispatcherDir}/relocated.v2/${repo}`
          marker(sidFile(repo), `${sid}\n`)
          marker(cwdFile(repo), `${recordedCwd}\n`)
          writeTranscript(recordedCwd, sid, [usageLine(8000, 0, 0, 120)])
          return { args: [repo] }
        },
      },
      {
        name: 'multiple repos each yield a line, in argument order',
        setup: () => {
          const repoA = uniqueName()
          const repoB = uniqueName()
          for (const repo of [repoA, repoB]) {
            const sid = uniqueName()
            marker(sidFile(repo), `${sid}\n`)
            writeTranscript(defaultCwd(repo), sid, [usageLine(6000, 1000, 2000, 90)])
          }
          return { args: [repoA, repoB] }
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
