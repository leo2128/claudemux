/**
 * The conformance harness — golden-file pin for every migrated verb.
 *
 * Bash `bin/tm` is retired on the `next` line, so this no longer runs the
 * real `bin/tm` as a live oracle. Instead each scenario runs the native
 * handler once and compares its `TmResult` to a committed golden JSON file
 * at `test/goldens/<verb>/<slug>.json`. A mutating verb (`kill`, `archive`,
 * `reload`) additionally pins its post-state — what changed on the
 * filesystem — to a sibling `<slug>.fs.json`.
 *
 * Determinism:
 *  - tmux — a fake `tmux` (`fixtures/fake-tmux-bin/tmux`) returns a
 *    test-controlled session list. The native runner reaches it through
 *    `CLAUDEMUX_TMUX`, so the harness needs no real tmux.
 *  - Random IDs — each scenario receives its own deterministic name
 *    generator seeded from `${verb}/${name}`, so `uniqueName()` returns the
 *    same hex string on every run and goldens are byte-stable.
 *  - The sandbox dispatcher dir is a **fixed** path under `/tmp`. A random
 *    `mkdtemp` path would change every run, baking the run-specific dir into
 *    the goldens through the project-dir encoding (`/tmp/<rand>/...` →
 *    `-tmp-<rand>-...`); a stable path keeps the encoded paths stable, so
 *    they read as ordinary strings in the goldens.
 *  - Sanitization — only one variable (`sandboxHome`, which carries the
 *    user's literal `HOME` only when realpath collapses through it) is
 *    substituted with `<HOME>` before compare and write.
 *
 * Updating goldens:
 *
 *   UPDATE_GOLDENS=1 npx vitest run test/conformance.test.ts
 *
 * regenerates every golden from the current native output, leaving a `git
 * diff` for the reviewer to read. Tests that lack a golden write a new one
 * and fail on the first run, so the *initial* PR adds the goldens in lockstep
 * with the scenarios.
 *
 * Adding a verb or scenario: append a `{ verb, scenarios }` entry to
 * `CONFORMANCE` below, then run with `UPDATE_GOLDENS=1` once to commit the
 * golden.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runColumn } from '../src/column'
import { runGrep } from '../src/grep'
import { NATIVE_VERBS } from '../src/native'
import {
  busyMarkerFor,
  cwdFile,
  encodeProjectDir,
  idleDir,
  idleMarkerFor,
  lastFileFor,
  readyFile,
  sendAtFile,
  sidFile,
} from '../src/paths'
import type { TmResult } from '../src/tm'
import { runTmux } from '../src/tmux'

/** This test file's directory — `core/test`. */
const HARNESS_DIR = dirname(fileURLToPath(import.meta.url))
/** The fake `tmux` dir — the native runner reaches it through `CLAUDEMUX_TMUX`. */
const FAKE_TMUX_DIR = join(HARNESS_DIR, 'fixtures', 'fake-tmux-bin')
const FAKE_TMUX = join(FAKE_TMUX_DIR, 'tmux')
/** Where committed golden JSON files live, one per scenario. */
const GOLDENS_DIR = join(HARNESS_DIR, 'goldens')
/** When `1`, the harness writes the observed result/effect as the new golden. */
const UPDATE_GOLDENS = process.env.UPDATE_GOLDENS === '1'

/**
 * A fixed scratch root. A random `mkdtemp` path would bake itself into
 * every goldened project-dir encoding (`encodeProjectDir` folds `/` to `-`
 * character-by-character, so the run-specific hash survives into the
 * encoded directory name). Wiped and recreated in `beforeAll`.
 */
const scratchDir = '/tmp/claudemux-conf-test'
const sessionsFile = join(scratchDir, 'tmux-sessions')
const captureFile = join(scratchDir, 'tmux-capture')
const dispatcherDir = join(scratchDir, 'dispatcher')
const sandboxHome = join(scratchDir, 'home')
const projectsDir = join(sandboxHome, '.claude', 'projects')

/** `/tmp` marker files a scenario wrote — removed after that scenario. */
const tmpFiles: string[] = []
/** Env values saved on entry, restored after the file so nothing leaks. */
let savedTmux: string | undefined
let savedSessions: string | undefined
let savedCapture: string | undefined
let savedCodexRegistryRoot: string | undefined
let savedTz: string | undefined

/**
 * The resolved-realpath form of `scratchDir` and the two `encodeProjectDir`
 * encodings that can appear in a verb's output — one for the realpath form
 * and one for the literal `scratchDir`. Computed in `beforeAll` (after the
 * dir is created), used by `sanitize()` to absorb the macOS-vs-Linux `/tmp`
 * symlink difference.
 *
 *   - On Linux `/tmp` is a real directory, so `realpathSync(scratchDir)` is
 *     `scratchDir` itself and both encoded forms collapse to
 *     `-tmp-claudemux-conf-test`.
 *   - On macOS `/tmp` is a symlink to `/private/tmp`. `realpathSync` returns
 *     `/private/tmp/claudemux-conf-test` and that encodes to
 *     `-private-tmp-claudemux-conf-test`; the literal `scratchDir` still
 *     encodes to `-tmp-claudemux-conf-test`.
 *
 * Different verbs reach different forms in their output:
 *
 *   - `tm history` realpaths the repo path before encoding (mirroring
 *     `tm`'s `cd && pwd -P`), so its `file:` line carries the realpath form.
 *   - `tm archive` and `tm mem` encode `dispatcherDir` *without* realpath,
 *     so their stderr / file paths carry the literal form regardless of OS.
 *
 * Substituting both forms to the same `<SCRATCH-ENC>` placeholder keeps the
 * golden byte-stable whichever path each verb takes — on Linux the two
 * substitutions are duplicates and the second is a no-op.
 */
let scratchDirReal = ''
let encodedScratchReal = ''
let encodedScratchLiteral = ''

// Pin the timezone for the whole conformance file — set at module load so
// the FIXED_NOW Date literal below resolves under UTC, before any Date
// operation reaches the OS's local zone. `tm history`'s detail page formats
// `last_seen` with `new Date(...).getHours()` / `.getMinutes()` etc, which
// honor the process timezone; without this pin the goldens shift between
// the dev machine (UTC+8 on the author's box) and CI (UTC). Node consults
// `process.env.TZ` via `tzset()` on each Date construction, so writing it
// here takes effect on subsequent Date operations even though Node has
// already started.
savedTz = process.env.TZ
process.env.TZ = 'UTC'

/**
 * The wall-clock the harness pins. `tm history`'s detail page renders an
 * absolute `last_seen` line (and `tm archive` stamps today's date into the
 * archive ledger). Both reach `Date.now()` / `new Date()` directly; without
 * a pinned clock the goldens would shift every run. Vitest's
 * `useFakeTimers({ toFake: ['Date'] })` freezes `Date` without freezing
 * `setTimeout` / `setInterval`, so the hot-path verbs' poll loops still
 * advance through real time (their conformance scenarios never enter those
 * loops, but pinning that fact in the harness is the right discipline).
 */
const FIXED_NOW = new Date('2026-05-23T12:00:00Z')

beforeAll(() => {
  // Save the env first, before anything that can throw, so `afterAll` can
  // restore the real values even if setup fails partway.
  savedTmux = process.env.CLAUDEMUX_TMUX
  savedSessions = process.env.FAKE_TMUX_SESSIONS
  savedCapture = process.env.FAKE_TMUX_CAPTURE
  savedCodexRegistryRoot = process.env.CLAUDEMUX_CODEX_REGISTRY_ROOT

  // Pin Date for the whole file — see FIXED_NOW above.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(FIXED_NOW)

  // Fixed scratch — wipe and recreate so every run starts clean.
  rmSync(scratchDir, { recursive: true, force: true })
  mkdirSync(projectsDir, { recursive: true })
  mkdirSync(dispatcherDir, { recursive: true })
  mkdirSync(idleDir(), { recursive: true })
  writeFileSync(sessionsFile, '')
  writeFileSync(captureFile, '')

  // Now that the dir exists, capture its realpath form and *both* encoded
  // forms — realpath-encoded and literal-encoded. See the variable docs above.
  scratchDirReal = realpathSync(scratchDir)
  encodedScratchReal = encodeProjectDir(scratchDirReal)
  encodedScratchLiteral = encodeProjectDir(scratchDir)

  // Point native `runTmux` at the fake `tmux`.
  process.env.CLAUDEMUX_TMUX = FAKE_TMUX
  process.env.FAKE_TMUX_SESSIONS = sessionsFile
  process.env.FAKE_TMUX_CAPTURE = captureFile
  process.env.CLAUDEMUX_CODEX_REGISTRY_ROOT = join(scratchDir, 'codex-registry')
})

afterAll(() => {
  vi.useRealTimers()
  if (savedTmux === undefined) delete process.env.CLAUDEMUX_TMUX
  else process.env.CLAUDEMUX_TMUX = savedTmux
  if (savedSessions === undefined) delete process.env.FAKE_TMUX_SESSIONS
  else process.env.FAKE_TMUX_SESSIONS = savedSessions
  if (savedCapture === undefined) delete process.env.FAKE_TMUX_CAPTURE
  else process.env.FAKE_TMUX_CAPTURE = savedCapture
  if (savedCodexRegistryRoot === undefined) delete process.env.CLAUDEMUX_CODEX_REGISTRY_ROOT
  else process.env.CLAUDEMUX_CODEX_REGISTRY_ROOT = savedCodexRegistryRoot
  if (savedTz === undefined) delete process.env.TZ
  else process.env.TZ = savedTz
  if (existsSync(scratchDir)) rmSync(scratchDir, { recursive: true, force: true })
})

afterEach(() => {
  for (const file of tmpFiles.splice(0)) {
    if (existsSync(file)) rmSync(file, { force: true })
  }
})

/** Run the native handler for the given args; the only runner the harness drives. */
function runNative(verb: string, args: readonly string[], stdin?: string): Promise<TmResult> {
  const handler = NATIVE_VERBS[verb]
  if (!handler) throw new Error(`no native handler for ${verb}`)
  return handler(args, stdin != null ? { stdin } : undefined, {
    runTmux,
    runColumn,
    runGrep,
    dispatcherDir,
    projectsDir,
  })
}

/**
 * Per-scenario deterministic name source. `uniqueName()` consults this so
 * every scenario produces byte-stable names across runs — goldens never
 * shift just because a UUID rotated. The seed is `${verb}/${scenario name}`.
 */
let currentRng: () => string = () => {
  throw new Error('uniqueName() called outside a scenario — scenario.setup() must run inside the harness loop')
}

function scenarioRng(seed: string): () => string {
  let counter = 0
  // Full 64-hex digest so a consumer can slice the bytes it needs.
  return () => createHash('sha256').update(`${seed}:${counter++}`).digest('hex')
}

/** Slugify a scenario name to a filesystem-safe golden filename. */
function slug(name: string): string {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return clean.length > 0 ? clean.slice(0, 80) : 'scenario'
}

/** The golden path for a verb's scenario result. */
function goldenPath(verb: string, scenarioName: string): string {
  return join(GOLDENS_DIR, verb, `${slug(scenarioName)}.json`)
}

/** The golden path for a mutating-verb scenario's post-state filesystem snapshot. */
function fsGoldenPath(verb: string, scenarioName: string): string {
  return join(GOLDENS_DIR, verb, `${slug(scenarioName)}.fs.json`)
}

function loadGolden<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function saveGolden(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Sanitize a string by replacing run-specific paths with stable placeholders.
 * `scratchDir` is fixed, but: on macOS `/tmp` is a symlink to `/private/tmp`,
 * so `realpathSync(scratchDir)` differs from `scratchDir` and the encoded
 * project-dir name (`encodeProjectDir(realpath)`) carries that difference
 * into every golden. Substitute the realpath and encoded-realpath forms too
 * so a golden generated on either OS reads identically.
 *
 * Substitution order: most-specific first.
 *   `sandboxHome` ⊂ `scratchDir`, so the `<HOME>` pass must run first or
 *   `<SCRATCH>` would absorb the `/home`-suffix path before `<HOME>` saw it.
 *   The encoded form has no overlap with the slash-bearing path forms, so
 *   its order is independent.
 */
function sanitize(value: string): string {
  return value
    .replaceAll(encodedScratchReal, '<SCRATCH-ENC>')
    .replaceAll(encodedScratchLiteral, '<SCRATCH-ENC>')
    .replaceAll(sandboxHome, '<HOME>')
    .replaceAll(scratchDirReal, '<SCRATCH>')
    .replaceAll(scratchDir, '<SCRATCH>')
}

function sanitizeResult(result: TmResult): TmResult {
  return {
    code: result.code,
    stdout: sanitize(result.stdout),
    stderr: sanitize(result.stderr),
  }
}

function sanitizeSnapshot(snap: FsSnapshot): FsSnapshot {
  const out: FsSnapshot = {}
  for (const [path, content] of Object.entries(snap)) {
    out[sanitize(path)] = content === null ? null : sanitize(content)
  }
  return out
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

/** Set the pane buffer the fake `tmux capture-pane` returns. */
function setCapture(text: string): void {
  writeFileSync(captureFile, text)
}

/**
 * A test repo/sid name that cannot collide with a real teammate. Each call
 * within a scenario returns a fresh name; the sequence is deterministic per
 * scenario, so goldens stay byte-stable across runs.
 */
function uniqueName(): string {
  return `claudemux-conftest-${currentRng().slice(0, 12)}`
}

/**
 * A deterministic UUID-formatted hex string (8-4-4-4-12). Each call within
 * a scenario returns a fresh value. For sids that must pass UUID-shape
 * validation in `tm resume` / `tm history` detail.
 */
function uniqueUuid(): string {
  const hex = currentRng()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
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

/** An assistant usage line with no cache fields — a non-cached / older turn. */
function usageLineNoCache(input: number, output: number): string {
  return JSON.stringify({
    type: 'assistant',
    message: { usage: { input_tokens: input, output_tokens: output } },
  })
}

/** Write a teammate's transcript jsonl under the sandbox projects dir. */
function writeTranscript(cwd: string, sid: string, lines: string[]): void {
  const dir = join(projectsDir, encodeProjectDir(cwd))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${sid}.jsonl`), lines.length > 0 ? `${lines.join('\n')}\n` : '')
}

/**
 * Write a teammate's `.last` marker, pinning its mtime `ageSeconds` in the
 * past. `states` reports the file's age via `fmt_age`; the default 10000s
 * sits solidly mid-bucket (`2h`), so the ≤1s skew between the `tm` and native
 * `now` samplings cannot cross a bucket boundary and flake the check. A caller
 * exercising a different `fmt_age` bucket passes an age that is likewise clear
 * of its bucket edges.
 */
function writeLastMarker(sid: string, content: string, ageSeconds = 10000): void {
  const file = lastFileFor(sid)
  marker(file, content)
  const pinned = Math.floor(Date.now() / 1000) - ageSeconds
  utimesSync(file, pinned, pinned)
}

/**
 * The auto-memory `MEMORY.md` path for a teammate repo — mirrors `tm`'s
 * `project_dir_for_repo`. The repo directory must already exist on disk, so
 * the physical-path resolution matches `tm`'s `cd && pwd -P`.
 */
function memoryFile(repo: string): string {
  const phys = realpathSync(join(dispatcherDir, repo))
  return join(projectsDir, encodeProjectDir(phys), 'memory', 'MEMORY.md')
}

/** Create a teammate repo directory under the sandbox dispatcher dir. */
function makeRepoDir(repo: string): void {
  mkdirSync(join(dispatcherDir, repo), { recursive: true })
}

/** Write a teammate's auto-memory `MEMORY.md`; the repo dir must exist first. */
function writeMemory(repo: string, content: string): void {
  const file = memoryFile(repo)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

/** The Claude Code project directory for a repo — mirrors `tm`'s `project_dir_for_repo`. */
function historyProjectDir(repo: string): string {
  const phys = realpathSync(join(dispatcherDir, repo))
  return join(projectsDir, encodeProjectDir(phys))
}

/**
 * Write a past-session transcript jsonl for a repo, pinning its mtime
 * `ageSeconds` in the past — `tm history`'s `AGE` column and `ls -t` ordering
 * both read mtime, so a scenario with several sessions passes distinct,
 * bucket-stable ages. The repo directory must already exist on disk.
 */
function writeHistoryTranscript(
  repo: string,
  sidName: string,
  lines: string[],
  ageSeconds = 10000,
): void {
  const dir = historyProjectDir(repo)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${sidName}.jsonl`)
  writeFileSync(file, lines.length > 0 ? `${lines.join('\n')}\n` : '')
  const pinned = Math.floor(Date.now() / 1000) - ageSeconds
  utimesSync(file, pinned, pinned)
}

/**
 * A `user` transcript line carrying a plain-string prompt, optionally
 * timestamped. Real Claude Code entries always carry a `.timestamp`, so a
 * `history`-detail fixture passes one to stay realistic — see the note on
 * `readHistoryData` for why a timestamp-less transcript is a degenerate case.
 */
function userLine(text: string, timestamp?: string): string {
  const entry: Record<string, unknown> = {
    type: 'user',
    message: { role: 'user', content: text },
  }
  if (timestamp !== undefined) entry.timestamp = timestamp
  return JSON.stringify(entry)
}

/** An `assistant` transcript line carrying one `text` content block. */
function assistantTextLine(text: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
}

/**
 * The files `tm kill` can touch — its four repo-keyed `/tmp` files, the fake
 * `tmux`'s session list (`kill-session` rewrites it), and, when there is a
 * sid, that sid's three idle markers. A `kill` scenario snapshots this set.
 */
function killWorld(repo: string, sid?: string): string[] {
  const paths = [sidFile(repo), sendAtFile(repo), readyFile(repo), cwdFile(repo), sessionsFile]
  if (sid !== undefined) {
    paths.push(idleMarkerFor(sid), lastFileFor(sid), busyMarkerFor(sid))
  }
  return paths
}

/**
 * The files a `tm reload` fan-out can touch for one teammate — its `.send-at`
 * file, and (when a sid is seeded) that sid's idle markers, the effects of the
 * `tm send` `_send_keys` each fan-out target runs.
 */
function reloadWorld(repo: string, sid?: string): string[] {
  const paths = [sendAtFile(repo)]
  if (sid !== undefined) {
    paths.push(idleMarkerFor(sid), lastFileFor(sid), busyMarkerFor(sid))
  }
  return paths
}

/** The dispatcher's auto-memory directory — `tm`'s `memory_dir`, the `archive` world. */
function archiveMemoryDir(): string {
  return join(projectsDir, encodeProjectDir(dispatcherDir), 'memory')
}

/**
 * Wipe and recreate the memory directory. `tm`'s `memory_dir` is keyed to the
 * dispatcher, not a per-test name, so every `archive` scenario starts from a
 * clean slate here rather than inheriting the previous scenario's ledgers.
 */
function resetMemoryDir(): void {
  const dir = archiveMemoryDir()
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
}

/** Write the active dispatcher-task ledger; the memory dir must exist first. */
function writeActiveLedger(content: string): void {
  writeFileSync(join(archiveMemoryDir(), 'active-dispatcher-tasks.md'), content)
}

/** Write the dispatcher-task archive ledger; the memory dir must exist first. */
function writeArchiveLedger(content: string): void {
  writeFileSync(join(archiveMemoryDir(), 'dispatcher-tasks-archive.md'), content)
}

/** A two-entry active ledger — `t-alpha` mid-list, `t-beta` last. */
const STANDARD_LEDGER = `# Active dispatcher tasks

### t-alpha  [in progress]
- repo: acme
- branch: feature/login
- intent: wire up the login flow
- notes: blocked on review

### t-beta  [PAUSED — waiting on infra]
- repo: widgets
- branch: main
- intent: ship the widget
`

/**
 * A filesystem snapshot — each path mapped to its content, or `null` when the
 * path is absent. A mutating verb (`kill`, `archive`) cannot be conformance-
 * checked by running the oracle and native against the *same* fixture: the
 * oracle changes the world the native run would then see. Such a scenario
 * instead supplies a `snapshot` closure; the harness snapshots the world,
 * runs the oracle, snapshots its effect, resets the world, runs native, and
 * asserts the two post-states match (as well as the two `TmResult`s).
 */
type FsSnapshot = Record<string, string | null>

/** Snapshot an explicit set of file paths — for a verb with a fixed world. */
function snapshotPaths(paths: readonly string[]): FsSnapshot {
  const snap: FsSnapshot = {}
  for (const path of paths) {
    snap[path] = existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  return snap
}

/** Snapshot every file under a directory tree — for a verb whose world is a subtree. */
function snapshotTree(root: string): FsSnapshot {
  const snap: FsSnapshot = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else snap[full] = readFileSync(full, 'utf8')
    }
  }
  try {
    walk(root)
  } catch {
    // An absent root is an empty snapshot — `archive` may run before its dir.
  }
  return snap
}

/**
 * Restore the world to `base`: every path `base` records is written back (or
 * deleted when it was absent), and any path present only in `touched` — one
 * the run being undone created — is deleted.
 */
function resetSnapshot(base: FsSnapshot, touched: FsSnapshot): void {
  for (const path of new Set([...Object.keys(base), ...Object.keys(touched)])) {
    const content = base[path] ?? null
    if (content === null) {
      rmSync(path, { force: true })
    } else {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
    }
  }
}

/** One conformance scenario: prepare the fixture, return the verb args. */
interface Scenario {
  name: string
  /**
   * Prepare the fixture and return the verb's arguments. A mutating verb also
   * returns a `snapshot` closure capturing its world — its presence switches
   * the harness to the snapshot / reset / effects-diff path.
   */
  setup: () => { args: string[]; stdin?: string; snapshot?: () => FsSnapshot }
  /**
   * Run this scenario only on macOS. `tm history`'s detail-mode success path
   * formats a timestamp with BSD `date -r <epoch>`; on GNU `date -r` means
   * "reference file", so under `tm`'s `set -e` the whole invocation crashes.
   * The native verb is correct on either OS — but the differential oracle is
   * only sane where `tm` itself is, so those scenarios are pinned to macOS.
   */
  darwinOnly?: boolean
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
        name: 'a usage object with no cache fields → cache tokens count as zero',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          marker(sidFile(repo), `${sid}\n`)
          // The common shape of a non-cached / older turn: `input_tokens` and
          // `output_tokens` only. `jq`'s `number + null` is `number`; native's
          // missing-field-as-zero must agree.
          writeTranscript(defaultCwd(repo), sid, [usageLineNoCache(7000, 200)])
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
        name: 'a syntactically invalid JSON line fails the file, as jq does',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          marker(sidFile(repo), `${sid}\n`)
          // `{not json` is not parseable: `jq -s` syntax-errors the whole pass,
          // and the native `JSON.parse` throws — both must fail the file.
          writeTranscript(defaultCwd(repo), sid, ['{not json', usageLine(5000, 0, 0, 100)])
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
  {
    verb: 'states',
    scenarios: [
      {
        name: 'no running teammates → the "no teammate sessions" line',
        setup: () => {
          setSessions('')
          return { args: [] }
        },
      },
      {
        name: 'a teammate with a sid and a .last → a full row',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          marker(sidFile(repo), `${sid}\n`)
          writeLastMarker(sid, 'the last reply line\nand a second line\n')
          return { args: [] }
        },
      },
      {
        name: 'a teammate with a sid but no .last → the LAST/PREVIEW dashes',
        setup: () => {
          const repo = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          marker(sidFile(repo), `${uniqueName()}\n`)
          return { args: [] }
        },
      },
      {
        name: 'a teammate with no sid file → the "?" SID',
        setup: () => {
          const repo = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          return { args: [] }
        },
      },
      {
        name: 'a teammate mid-turn → BUSY is yes',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          marker(sidFile(repo), `${sid}\n`)
          marker(busyMarkerFor(sid), '')
          writeLastMarker(sid, 'a reply\n')
          return { args: [] }
        },
      },
      {
        name: 'a CJK preview is truncated by character, not byte',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          marker(sidFile(repo), `${sid}\n`)
          writeLastMarker(
            sid,
            '已完成任务这是一段足够长的中文回复预览内容用来验证按字符而不是按字节截断到五十个字符的行为再多写些文字凑长度\n',
          )
          return { args: [] }
        },
      },
      {
        name: 'control characters in the preview are stripped',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          marker(sidFile(repo), `${sid}\n`)
          // TAB (9), SOH (1), BEL (7), built here so no control character
          // is ever a literal byte in this source file.
          const ctrls = `vis${String.fromCharCode(9)}ible${String.fromCharCode(1, 7)}text`
          writeLastMarker(sid, `${ctrls}\nsecond line\n`)
          return { args: [] }
        },
      },
      {
        name: 'a preview that is all control characters → "(no first line)"',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          marker(sidFile(repo), `${sid}\n`)
          const onlyCtrls = String.fromCharCode(1, 2, 3, 7)
          writeLastMarker(sid, `${onlyCtrls}\nreal second line\n`)
          return { args: [] }
        },
      },
      {
        name: 'multiple teammates of differing name length → aligned columns',
        setup: () => {
          const short = uniqueName()
          const long = `${uniqueName()}-and-a-considerably-longer-name`
          setSessions(`${sessionLine(short)}\n${sessionLine(long)}\n`)
          for (const repo of [short, long]) {
            const sid = uniqueName()
            marker(sidFile(repo), `${sid}\n`)
            writeLastMarker(sid, `reply for ${repo}\n`)
          }
          return { args: [] }
        },
      },
      {
        name: 'a non-ASCII teammate name is aligned by the real column',
        setup: () => {
          // A CJK repo name's column width is whatever the real `column`
          // measures, not its code-unit count — both sides pipe through that
          // same `column`, so they must agree.
          const repo = `${uniqueName()}-中文目录`
          const sid = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          marker(sidFile(repo), `${sid}\n`)
          writeLastMarker(sid, 'a reply for the cjk-named teammate\n')
          return { args: [] }
        },
      },
      {
        name: 'a .last age in the minutes bucket → fmt_age renders the m form',
        setup: () => {
          // The other rows pin `.last` 10000s back (the `h` bucket); 1830s
          // exercises `fmt_age`'s `m` branch. 1830 mod 60 = 30, so the ≤1s
          // skew between the tm and native `now` samplings stays inside `30m`.
          const repo = uniqueName()
          const sid = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          marker(sidFile(repo), `${sid}\n`)
          writeLastMarker(sid, 'a reply in the minutes bucket\n', 1830)
          return { args: [] }
        },
      },
    ],
  },
  {
    verb: 'mem',
    scenarios: [
      {
        name: 'no repo argument → the usage error',
        setup: () => ({ args: [] }),
      },
      {
        name: 'a repo that is not a dispatcher subdirectory → the repo-not-found error',
        setup: () => ({ args: [uniqueName()] }),
      },
      {
        name: 'repo present, MEMORY.md present → the index is printed verbatim',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          writeMemory(repo, '# Memory Index\n\n- [a fact](a.md) — a hook\n')
          return { args: [repo] }
        },
      },
      {
        name: 'repo present, no MEMORY.md → the "no auto-memory" notice, exit 0',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          return { args: [repo] }
        },
      },
      {
        name: 'an empty MEMORY.md → empty output, exit 0 (a file is still a file)',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          writeMemory(repo, '')
          return { args: [repo] }
        },
      },
      {
        name: 'a MEMORY.md with CJK / multibyte content survives both paths intact',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          writeMemory(repo, '# 记忆索引\n\n- 第一条:emoji 🚀 也要原样回来\n')
          return { args: [repo] }
        },
      },
    ],
  },
  {
    verb: 'history',
    scenarios: [
      {
        name: 'no repo argument → the usage error',
        setup: () => ({ args: [] }),
      },
      {
        name: 'a repo that is not a dispatcher subdirectory → the repo-not-found error',
        setup: () => ({ args: [uniqueName()] }),
      },
      {
        name: 'repo present, no project dir → the "no past sessions" line',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          return { args: [repo] }
        },
      },
      {
        name: 'project dir present but holding no transcripts → the "no past sessions" line',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          mkdirSync(historyProjectDir(repo), { recursive: true })
          return { args: [repo] }
        },
      },
      {
        name: 'one past session → a single-row table',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          writeHistoryTranscript(repo, uniqueName(), [
            userLine('review the auth refactor'),
            assistantTextLine('looked it over'),
          ])
          return { args: [repo] }
        },
      },
      {
        name: 'multiple sessions → listed newest-first, columns aligned by column',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          // Distinct, bucket-stable ages: `ls -t` orders them newest-first.
          writeHistoryTranscript(repo, uniqueName(), [userLine('the newest task')], 4000)
          writeHistoryTranscript(repo, uniqueName(), [userLine('the middle task')], 40000)
          writeHistoryTranscript(repo, uniqueName(), [userLine('the oldest task')], 100000)
          return { args: [repo] }
        },
      },
      {
        name: 'a session with no user prompt → the "(no user prompt)" topic',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          writeHistoryTranscript(repo, uniqueName(), [assistantTextLine('only an assistant turn')])
          return { args: [repo] }
        },
      },
      {
        name: 'the live session is flagged with * in the mark column',
        setup: () => {
          const repo = uniqueName()
          const liveSid = uniqueName()
          makeRepoDir(repo)
          writeHistoryTranscript(repo, liveSid, [userLine('the live session')], 5000)
          writeHistoryTranscript(repo, uniqueName(), [userLine('an older session')], 50000)
          marker(sidFile(repo), `${liveSid}\n`)
          return { args: [repo] }
        },
      },
      {
        name: 'a control-char / CJK first prompt → stripped and char-truncated topic',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          // SOH (1) and BEL (7) are stripped; the CJK run is truncated to 60
          // code points, not 60 bytes — built so no control char is a literal.
          const prompt = `${String.fromCharCode(1, 7)}诊断这个上下文窗口使用问题这是一段足够长的中文首条提示用来验证按字符截断到六十个字符的行为再补一些文字`
          writeHistoryTranscript(repo, uniqueName(), [userLine(prompt)])
          return { args: [repo] }
        },
      },
      {
        name: 'detail: an invalid sid prefix → the validation error',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          return { args: [repo, 'XYZ-not-hex'] }
        },
      },
      {
        name: 'detail: no project dir → the "no project dir" error',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          return { args: [repo, 'abcdef'] }
        },
      },
      {
        name: 'detail: a prefix matching no session → the not-found error',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          writeHistoryTranscript(repo, uniqueName(), [userLine('a session that will not match')])
          return { args: [repo, 'bbbbbbbb'] }
        },
      },
      {
        name: 'detail: a prefix matching multiple sessions → the ambiguity error',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          const shared = uniqueUuid().slice(0, 8)
          writeHistoryTranscript(repo, `${shared}-1111`, [userLine('first')])
          writeHistoryTranscript(repo, `${shared}-2222`, [userLine('second')])
          return { args: [repo, shared] }
        },
      },
      {
        name: 'detail: a resolved session → the full detail block',
        darwinOnly: true,
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueUuid()
          makeRepoDir(repo)
          writeHistoryTranscript(repo, sid, [
            JSON.stringify({
              type: 'user',
              message: { role: 'user', content: 'review the auth flow' },
              timestamp: '2026-05-12T14:21:33.000Z',
            }),
            assistantTextLine('here is the review of the auth flow'),
            usageLine(8000, 1000, 2000, 150),
          ])
          return { args: [repo, sid.slice(0, 8)] }
        },
      },
      {
        name: 'detail: a transcript whose peak exceeds 210k → the detected-1M ctx line',
        darwinOnly: true,
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueUuid()
          makeRepoDir(repo)
          writeHistoryTranscript(repo, sid, [
            userLine('a long-running session', '2026-05-12T09:15:00.000Z'),
            assistantTextLine('working on it'),
            usageLine(250000, 0, 0, 100),
          ])
          return { args: [repo, sid.slice(0, 8)] }
        },
      },
      {
        name: 'detail: a transcript with no usage → the "(no usage data)" ctx line',
        darwinOnly: true,
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueUuid()
          makeRepoDir(repo)
          writeHistoryTranscript(repo, sid, [
            userLine('a question', '2026-05-12T09:15:00.000Z'),
            assistantTextLine('an answer'),
          ])
          return { args: [repo, sid.slice(0, 8)] }
        },
      },
      {
        name: 'detail: an unparseable transcript line → the jq-failure sentinel rendering',
        darwinOnly: true,
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueUuid()
          makeRepoDir(repo)
          // `{not json` syntax-errors `jq -s`, failing the whole pass — `tm`
          // falls back to six empty fields, and native's `JSON.parse` throws.
          writeHistoryTranscript(repo, sid, [
            '{not json',
            userLine('a question'),
            assistantTextLine('an answer'),
          ])
          return { args: [repo, sid.slice(0, 8)] }
        },
      },
      {
        name: 'detail: a last-assistant text past 1500 chars is truncated',
        darwinOnly: true,
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueUuid()
          makeRepoDir(repo)
          writeHistoryTranscript(repo, sid, [
            userLine('produce a long answer', '2026-05-12T09:15:00.000Z'),
            assistantTextLine('x'.repeat(2000)),
          ])
          return { args: [repo, sid.slice(0, 8)] }
        },
      },
    ],
  },
  {
    verb: 'status',
    scenarios: [
      {
        name: 'no repo argument → the usage error',
        setup: () => ({ args: [] }),
      },
      {
        name: 'a repo with no tmux session → the no-such-session error',
        setup: () => {
          setSessions('')
          return { args: [uniqueName()] }
        },
      },
      {
        name: 'a running teammate → the captured pane is printed verbatim',
        setup: () => {
          const repo = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          setCapture('the first pane line\nthe second pane line\n')
          return { args: [repo] }
        },
      },
      {
        name: 'an explicit lines argument is accepted',
        setup: () => {
          const repo = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          setCapture('a captured screen\n')
          return { args: [repo, '40'] }
        },
      },
      {
        name: 'an empty pane → empty output',
        setup: () => {
          const repo = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          setCapture('')
          return { args: [repo] }
        },
      },
      {
        name: 'a pane with CJK / multibyte content survives both paths intact',
        setup: () => {
          const repo = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          setCapture('teammate 屏幕内容\nemoji 🚀 也要原样\n')
          return { args: [repo] }
        },
      },
    ],
  },
  {
    verb: 'poll',
    scenarios: [
      {
        name: 'no arguments → the usage error',
        setup: () => ({ args: [] }),
      },
      {
        name: 'a repo but no pattern → the usage error',
        setup: () => ({ args: [uniqueName()] }),
      },
      {
        name: 'a repo with no tmux session → the no-such-session error',
        setup: () => {
          setSessions('')
          return { args: [uniqueName(), 'a-pattern'] }
        },
      },
      {
        name: 'a pattern already on the pane → matched, exit 0',
        setup: () => {
          const repo = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          setCapture('build output\nScheduled 3 tasks\n')
          return { args: [repo, 'Scheduled'] }
        },
      },
      {
        name: 'an ERE alternation matches via grep',
        setup: () => {
          const repo = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          setCapture('the build is complete\n')
          return { args: [repo, 'done|complete'] }
        },
      },
      {
        name: 'a pattern absent from the pane, timeout 0 → the timeout error',
        setup: () => {
          const repo = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          setCapture('nothing of interest here\n')
          // timeout 0: `end` equals `now`, so the poll loop never runs and
          // no `sleep 3` is reached — the check stays fast and deterministic.
          return { args: [repo, 'never-appears', '0'] }
        },
      },
    ],
  },
  {
    verb: 'kill',
    scenarios: [
      {
        name: 'no repo argument → the usage error',
        setup: () => ({ args: [] }),
      },
      {
        name: 'a running teammate with every marker → killed, all markers removed',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          marker(sidFile(repo), `${sid}\n`)
          marker(sendAtFile(repo), '1747900000\n')
          marker(readyFile(repo), '')
          marker(cwdFile(repo), '/some/teammate/cwd\n')
          marker(idleMarkerFor(sid), '')
          marker(lastFileFor(sid), 'the last reply\n')
          marker(busyMarkerFor(sid), '')
          return { args: [repo], snapshot: () => snapshotPaths(killWorld(repo, sid)) }
        },
      },
      {
        name: 'a teammate that is not running, with no markers → "not running", no effects',
        setup: () => {
          const repo = uniqueName()
          setSessions('')
          return { args: [repo], snapshot: () => snapshotPaths(killWorld(repo)) }
        },
      },
      {
        name: 'a sid file present but the session gone → idle markers cleared, "not running"',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          setSessions('')
          marker(sidFile(repo), `${sid}\n`)
          marker(idleMarkerFor(sid), '')
          marker(lastFileFor(sid), 'a stale reply\n')
          marker(busyMarkerFor(sid), '')
          return { args: [repo], snapshot: () => snapshotPaths(killWorld(repo, sid)) }
        },
      },
      {
        name: 'a running teammate with only a sid and cwd → killed, the present files removed',
        setup: () => {
          const repo = uniqueName()
          const sid = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          marker(sidFile(repo), `${sid}\n`)
          marker(cwdFile(repo), '/some/teammate/cwd\n')
          return { args: [repo], snapshot: () => snapshotPaths(killWorld(repo, sid)) }
        },
      },
    ],
  },
  {
    verb: 'archive',
    scenarios: [
      {
        name: 'no id argument → the usage error',
        setup: () => {
          resetMemoryDir()
          return { args: [], stdin: 'an outcome' }
        },
      },
      {
        name: 'an unknown flag → the unknown-flag error',
        setup: () => {
          resetMemoryDir()
          return { args: ['--bogus', 't-alpha'], stdin: 'an outcome' }
        },
      },
      {
        name: 'a second positional → the unexpected-arg error',
        setup: () => {
          resetMemoryDir()
          return { args: ['t-alpha', 't-beta'], stdin: 'an outcome' }
        },
      },
      {
        name: 'a bare --status with no value → tm exits 1 with no output',
        setup: () => {
          resetMemoryDir()
          return { args: ['--status'], stdin: 'an outcome' }
        },
      },
      {
        name: 'no active ledger → the no-ledger error',
        setup: () => {
          resetMemoryDir()
          return { args: ['t-alpha'], stdin: 'an outcome' }
        },
      },
      {
        name: 'a whitespace-only outcome on stdin → the outcome-required error',
        setup: () => {
          resetMemoryDir()
          writeActiveLedger(STANDARD_LEDGER)
          return { args: ['t-alpha'], stdin: '   \n \t ' }
        },
      },
      {
        name: 'an id not in the ledger → the not-found error with the available list',
        setup: () => {
          resetMemoryDir()
          writeActiveLedger(STANDARD_LEDGER)
          return { args: ['t-missing'], stdin: 'an outcome' }
        },
      },
      {
        name: 'an id matching two entries → the ambiguity error',
        setup: () => {
          resetMemoryDir()
          writeActiveLedger(
            '# Active dispatcher tasks\n\n### t-dup  [a]\n- repo: one\n\n### t-dup  [b]\n- repo: two\n',
          )
          return { args: ['t-dup'], stdin: 'an outcome' }
        },
      },
      {
        name: 'a happy-path archive → block cut from active, entry seeds a fresh archive',
        setup: () => {
          resetMemoryDir()
          writeActiveLedger(STANDARD_LEDGER)
          return {
            args: ['t-alpha'],
            stdin: 'shipped the login flow\n',
            snapshot: () => snapshotTree(archiveMemoryDir()),
          }
        },
      },
      {
        name: 'archiving when the archive file exists → entry prepended above the first',
        setup: () => {
          resetMemoryDir()
          writeActiveLedger(STANDARD_LEDGER)
          writeArchiveLedger(
            '# Dispatcher task archive\n\n### t-old  [done]\n- outcome: an earlier task\n',
          )
          return {
            args: ['t-alpha'],
            stdin: 'shipped it',
            snapshot: () => snapshotTree(archiveMemoryDir()),
          }
        },
      },
      {
        name: '--status overrides the carried [tag]',
        setup: () => {
          resetMemoryDir()
          writeActiveLedger(STANDARD_LEDGER)
          return {
            args: ['t-alpha', '--status', 'reverted'],
            stdin: 'rolled it back',
            snapshot: () => snapshotTree(archiveMemoryDir()),
          }
        },
      },
      {
        name: 'the last block in the ledger → archived through to EOF',
        setup: () => {
          resetMemoryDir()
          writeActiveLedger(STANDARD_LEDGER)
          return {
            args: ['t-beta'],
            stdin: 'the widget shipped',
            snapshot: () => snapshotTree(archiveMemoryDir()),
          }
        },
      },
      {
        name: 'a block with no repo/branch/intent lines → "(unknown)" fields',
        setup: () => {
          resetMemoryDir()
          writeActiveLedger('# Active dispatcher tasks\n\n### t-bare  [done]\n- notes: just a note\n')
          return {
            args: ['t-bare'],
            stdin: 'closed it out',
            snapshot: () => snapshotTree(archiveMemoryDir()),
          }
        },
      },
    ],
  },
  {
    verb: 'reload',
    scenarios: [
      {
        name: 'no arguments → the usage error',
        setup: () => ({ args: [] }),
      },
      {
        name: 'an unknown flag → the unknown-flag error',
        setup: () => ({ args: ['--bogus'] }),
      },
      {
        name: '--all together with an explicit repo → the conflict error',
        setup: () => ({ args: ['--all', uniqueName()] }),
      },
      {
        name: '--all with no running teammates → the "nothing to reload" line',
        setup: () => {
          setSessions('')
          return { args: ['--all'] }
        },
      },
      {
        name: 'fanning out to a teammate that is not running → stops at exit 1, no failed line',
        setup: () => {
          // The teammate has no session, so its `tm send` `die`s; `tm reload`
          // ends at that first failure — the `(failed)` line is unreachable.
          setSessions('')
          return { args: [uniqueName()] }
        },
      },
      {
        name: 'fanning out to a running teammate → the arrow line, send-at touched',
        setup: () => {
          const repo = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          return { args: [repo], snapshot: () => snapshotPaths(reloadWorld(repo)) }
        },
      },
      {
        name: 'a running then a not-running repo → first sent, second stops the fan-out',
        setup: () => {
          const running = uniqueName()
          const stopped = uniqueName()
          setSessions(`${sessionLine(running)}\n`)
          return {
            args: [running, stopped],
            snapshot: () =>
              snapshotPaths([...reloadWorld(running), ...reloadWorld(stopped)]),
          }
        },
      },
    ],
  },
  {
    verb: 'spawn',
    // The full happy path needs a real `claude` and a real tmux that
    // accepts `new-session -P -F` — neither is in this harness. The
    // live-teammate integration suite (`test/integration/hot-path.itest.ts`)
    // covers the round-trip; these scenarios pin every `cmd_spawn` exit
    // before the `tmux new-session` call.
    scenarios: [
      {
        name: 'no repo argument → the usage error',
        setup: () => ({ args: [] }),
      },
      {
        name: 'an unknown flag → the unknown-flag error',
        setup: () => ({ args: [uniqueName(), '--bogus'] }),
      },
      {
        name: '--prompt with no value → the requires-a-value error',
        setup: () => ({ args: [uniqueName(), '--prompt'] }),
      },
      {
        name: '--no-wait without --prompt → the validation error',
        setup: () => ({ args: [uniqueName(), '--no-wait'] }),
      },
      {
        name: 'a bare --task with no value → tm exits 1 with no output',
        setup: () => ({ args: [uniqueName(), '--task'] }),
      },
      {
        name: 'a bare --resume with no value → tm exits 1 with no output',
        setup: () => ({ args: [uniqueName(), '--resume'] }),
      },
      {
        name: 'a repo that is not a dispatcher subdirectory → the repo-not-found error',
        setup: () => ({ args: [uniqueName()] }),
      },
      {
        name: '--task with no usable characters → the slug-empty error',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          // `?!@#` has no chars in the allowlist; sanitization yields '' and
          // both implementations reject before touching tmux.
          return { args: [repo, '--task', '?!@#'] }
        },
      },
      {
        name: 'a session already running, with --prompt → the atomic-bootstrap-rejected error',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          setSessions(`${sessionLine(repo)}\n`)
          return { args: [repo, '--prompt', 'hi'] }
        },
      },
      {
        name: 'a session already running, no --prompt → the "already exists" notice, exit 0',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          setSessions(`${sessionLine(repo)}\n`)
          return { args: [repo] }
        },
      },
    ],
  },
  {
    verb: 'send',
    // The full round-trip (send + wait for Stop + print reply) needs a real
    // teammate and is exercised by the live-teammate integration suite. These
    // scenarios pin every flag-validation path and the `--no-wait` happy path
    // that fires against the fake tmux.
    scenarios: [
      {
        name: 'no arguments → the missing-repo error',
        setup: () => ({ args: [] }),
      },
      {
        name: 'a repo but no --prompt → the missing-prompt error',
        setup: () => ({ args: [uniqueName()] }),
      },
      {
        name: 'an unknown flag → the unknown-flag error',
        setup: () => ({ args: ['--bogus', uniqueName(), '--prompt', 'hi'] }),
      },
      {
        name: '--prompt with no value → the requires-a-value error',
        setup: () => ({ args: [uniqueName(), '--prompt'] }),
      },
      {
        name: '--timeout with no value → the requires-a-value error',
        setup: () => ({ args: [uniqueName(), '--prompt', 'hi', '--timeout'] }),
      },
      {
        name: 'no tmux session → the no-such-session error',
        setup: () => {
          setSessions('')
          return { args: [uniqueName(), '--prompt', 'hi'] }
        },
      },
      {
        name: '--no-wait against a running fake teammate → the send-at marker is touched',
        setup: () => {
          const repo = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          return {
            args: [repo, '--no-wait', '--prompt', 'hi'],
            snapshot: () => snapshotPaths([sendAtFile(repo)]),
          }
        },
      },
    ],
  },
  {
    verb: 'wait',
    // The blocking idle-marker poll is covered by the live-teammate suite;
    // here we pin every early-exit path (arg parsing + require_session).
    scenarios: [
      {
        name: 'no arguments → the usage error',
        setup: () => ({ args: [] }),
      },
      {
        name: 'an unknown flag → the unknown-flag error',
        setup: () => ({ args: ['--bogus', uniqueName()] }),
      },
      {
        name: 'no tmux session → the no-such-session error',
        setup: () => {
          setSessions('')
          return { args: [uniqueName()] }
        },
      },
      {
        name: 'a bare --timeout with no value → tm exits 1 with no output',
        setup: () => ({ args: [uniqueName(), '--timeout'] }),
      },
    ],
  },
  {
    verb: 'compact',
    // The PostCompact poll and pane refusal detection are covered by the
    // live-teammate suite; here we pin every early-exit path.
    scenarios: [
      {
        name: 'no arguments → the usage error',
        setup: () => ({ args: [] }),
      },
      {
        name: 'an unknown flag → the unknown-flag error',
        setup: () => ({ args: ['--bogus', uniqueName()] }),
      },
      {
        name: 'no tmux session → the no-such-session error',
        setup: () => {
          setSessions('')
          return { args: [uniqueName()] }
        },
      },
      {
        name: 'a running session but no sid file → the no-sid error',
        setup: () => {
          const repo = uniqueName()
          setSessions(`${sessionLine(repo)}\n`)
          return { args: [repo] }
        },
      },
      {
        name: 'a bare --timeout with no value → tm exits 1 with no output',
        setup: () => ({ args: [uniqueName(), '--timeout'] }),
      },
    ],
  },
  {
    verb: 'resume',
    // The full resume path needs a real `claude` and tmux; the live-teammate
    // suite covers it. These scenarios pin every `cmd_resume` exit before the
    // `cmd_spawn --resume` handoff.
    scenarios: [
      {
        name: 'no arguments → the usage error',
        setup: () => ({ args: [] }),
      },
      {
        name: 'an unknown flag → the unknown-flag error',
        setup: () => ({ args: [uniqueName(), '--bogus'] }),
      },
      {
        name: '--no-wait without --prompt → the validation error',
        setup: () => ({ args: [uniqueName(), '--no-wait'] }),
      },
      {
        name: 'a bare --task with no value → tm exits 1 with no output',
        setup: () => ({ args: [uniqueName(), '--task'] }),
      },
      {
        name: 'a repo that is not a dispatcher subdirectory → the repo-not-found error',
        setup: () => ({ args: [uniqueName()] }),
      },
      {
        name: 'too many positional arguments → the too-many-positionals error',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          return { args: [repo, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'extra'] }
        },
      },
      {
        name: 'a session already running → the already-running error',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          setSessions(`${sessionLine(repo)}\n`)
          return { args: [repo] }
        },
      },
      {
        name: 'no project dir, no sid → the "has anyone ever run claude" error',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          return { args: [repo] }
        },
      },
      // Skipped: "project dir exists but holds no jsonl, no sid" — bash
      // dies silently (exit 1, empty stderr) because `set -e` aborts at the
      // `ls "$dir"/*.jsonl` no-match before the next-line `die` fires. Native
      // produces the intended `no .jsonl transcripts ...` line; that is a
      // user-facing improvement, not bug-for-bug, so it does not pass the
      // differential check and is not scenarioed here.
      {
        name: 'explicit sid with no transcript at the target → the no-transcript error',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          mkdirSync(historyProjectDir(repo), { recursive: true })
          return { args: [repo, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'] }
        },
      },
      {
        name: 'a non-uuid sid that has a transcript → the invalid-uuid error',
        setup: () => {
          const repo = uniqueName()
          makeRepoDir(repo)
          // 8+ hex chars passes `cmd_history`'s prefix regex but fails the
          // `cmd_resume` strict UUID check — seed a transcript so the
          // existence guard does not fire first.
          mkdirSync(historyProjectDir(repo), { recursive: true })
          writeFileSync(join(historyProjectDir(repo), 'not-a-uuid.jsonl'), '')
          return { args: [repo, 'not-a-uuid'] }
        },
      },
    ],
  },
]

/**
 * One golden-file pin. `assertOrUpdate` is the heart of the harness:
 *
 *   - With `UPDATE_GOLDENS=1`, the observed value is written to disk; if a
 *     prior golden existed it is overwritten and the test passes.
 *   - Without the env, the golden is loaded from disk and `expect`d to equal
 *     the observed value. A missing golden writes the file *and* fails the
 *     test, so the initial PR cannot land its scenarios without committing
 *     the goldens.
 */
function assertOrUpdate<T>(path: string, observed: T): void {
  if (UPDATE_GOLDENS) {
    saveGolden(path, observed)
    return
  }
  const golden = loadGolden<T>(path)
  if (golden === undefined) {
    saveGolden(path, observed)
    throw new Error(
      `missing golden ${path}; wrote initial copy from this run — re-run with UPDATE_GOLDENS=1 to commit, then verify the diff`,
    )
  }
  expect(observed).toEqual(golden)
}

for (const { verb, scenarios } of CONFORMANCE) {
  describe(`${verb} — matches committed golden`, () => {
    for (const scenario of scenarios) {
      const run = scenario.darwinOnly && process.platform !== 'darwin' ? test.skip : test
      run(scenario.name, async () => {
        currentRng = scenarioRng(`${verb}/${scenario.name}`)
        const { args, stdin, snapshot } = scenario.setup()
        if (snapshot === undefined) {
          // Read-only verb — just compare the result.
          const result = sanitizeResult(await runNative(verb, args, stdin))
          assertOrUpdate(goldenPath(verb, scenario.name), result)
          return
        }
        // Mutating verb — pin the post-state alongside the result, then
        // restore the world from the pre-snapshot so the next scenario
        // (and `afterEach`'s `tmpFiles` cleanup, and the file-suite
        // `afterAll`'s `scratchDir` wipe) sees a clean slate.
        const before = snapshot()
        const result = sanitizeResult(await runNative(verb, args, stdin))
        const after = sanitizeSnapshot(snapshot())
        assertOrUpdate(goldenPath(verb, scenario.name), result)
        assertOrUpdate(fsGoldenPath(verb, scenario.name), after)
        resetSnapshot(before, snapshot())
      })
    }
  })
}
