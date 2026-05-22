/**
 * The live-teammate integration harness.
 *
 * The conformance harness (`test/conformance.test.ts`) pins the migrated verbs
 * to `tm`'s behavior with a *faked* tmux and no real Claude Code — it cannot
 * reach the racy hot path (`spawn`, `send`, `wait`, `compact`, `resume`), whose
 * correctness depends on a real `claude` REPL, real `tmux send-keys`, the
 * claudemux hooks, and the `/tmp/claude-idle` turn signal actually firing.
 *
 * This harness drives that hot path end to end: it spins up real `claude`
 * teammates in real tmux sessions through `tm` and asserts the round-trips
 * complete. It is opt-in — slow, and it needs a working `claude` install — so
 * it runs under its own vitest config (`vitest.integration.config.ts`), never
 * as part of `npm test`. See `test/integration/README.md`.
 *
 * ## What the harness must arrange for a teammate to work
 *
 * - **Directory trust.** A `claude` REPL started in a never-before-seen
 *   directory shows a blocking "do you trust this folder?" dialog; a teammate
 *   has no human to answer it, so its hooks never fire. The harness pre-seeds
 *   `hasTrustDialogAccepted` for each fixture repo into `~/.claude.json` — a
 *   *targeted* read-modify-write that only ever adds/removes the harness's own
 *   `projects.<fixture-path>` keys, never a wholesale save/restore (that would
 *   clobber the concurrent writes every other Claude Code process makes to
 *   that file). See decision 0020.
 * - **The claudemux plugin.** A teammate's hooks come from the claudemux
 *   plugin being installed and enabled for the machine. The harness does not
 *   inject the plugin; it treats it as a precondition — `probeLiveTeammate`
 *   spawns one throwaway teammate and checks its SessionStart hook fired, and
 *   the suite skips with a clear reason if it did not.
 *
 * ## The `tm` indirection — the seam the verb migration flips
 *
 * Every `tm` invocation routes through `resolveTmBinary` (`src/tm.ts`), which
 * honors the `CLAUDEMUX_TM` environment override. Today that resolves to the
 * Bash `bin/tm`. When stage 3's hot-path verbs are migrated to native code,
 * pointing `CLAUDEMUX_TM` at the native CLI re-aims this whole suite at it —
 * the harness itself does not change.
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { encodeProjectDir } from '../../src/paths'
import { spawnCapture } from '../../src/proc'
import { resolveTmBinary } from '../../src/tm'

/** The outcome of one `tm` invocation — the same shape `tm`'s verbs return. */
export interface TmOutcome {
  /** Process exit code. */
  code: number
  /** Captured standard output. */
  stdout: string
  /** Captured standard error. */
  stderr: string
}

/**
 * Format a `tm` outcome as an assertion-failure message. A bare
 * `expect(outcome.code).toBe(0)` reports only "expected 1 to be 0"; passing
 * this as `expect`'s second argument surfaces `tm`'s own stdout and stderr —
 * the `die` line that explains *why* — so a live failure is diagnosable from
 * the test log alone.
 */
export function tmDetail(label: string, outcome: TmOutcome): string {
  return (
    `${label} — exit ${outcome.code}\n` +
    `  stdout: ${JSON.stringify(outcome.stdout)}\n` +
    `  stderr: ${JSON.stringify(outcome.stderr)}`
  )
}

// --- ~/.claude.json directory-trust seeding -------------------------------
//
// The fixture repos live under a fresh temp dir, so a teammate started in one
// would hit the workspace-trust dialog. `~/.claude.json` records per-directory
// trust under `.projects.<path>.hasTrustDialogAccepted`; seeding that key for
// a fixture repo's *physical* path (the path `claude` actually runs in) lets
// the teammate boot straight to its REPL.

/** A loose view of `~/.claude.json` — only the `projects` map concerns us. */
type ClaudeJson = Record<string, unknown> & {
  projects?: Record<string, Record<string, unknown>>
}

/** The path to the real `~/.claude.json`. */
export function claudeJsonPath(): string {
  return join(homedir(), '.claude.json')
}

/**
 * Return a copy of `claudeJson` with `hasTrustDialogAccepted: true` set for
 * each path in `physPaths`. Any other fields an existing `projects.<path>`
 * entry carries are preserved; the input object is not mutated.
 */
export function withTrustedPaths(claudeJson: ClaudeJson, physPaths: readonly string[]): ClaudeJson {
  const projects = { ...(claudeJson.projects ?? {}) }
  for (const path of physPaths) {
    projects[path] = { ...(projects[path] ?? {}), hasTrustDialogAccepted: true }
  }
  return { ...claudeJson, projects }
}

/**
 * Return a copy of `claudeJson` with the `projects` entry for each path in
 * `physPaths` removed entirely. Fixture paths are unique temp paths the
 * harness created, so dropping the whole entry only ever discards the
 * harness's own teammate bookkeeping; the input object is not mutated.
 */
export function withoutProjectPaths(
  claudeJson: ClaudeJson,
  physPaths: readonly string[],
): ClaudeJson {
  const projects = { ...(claudeJson.projects ?? {}) }
  for (const path of physPaths) delete projects[path]
  return { ...claudeJson, projects }
}

/** Read and parse `~/.claude.json`. */
function readClaudeJson(): ClaudeJson {
  return JSON.parse(readFileSync(claudeJsonPath(), 'utf8')) as ClaudeJson
}

/**
 * Write `claudeJson` back to `~/.claude.json` atomically — a temp file plus a
 * rename, owner-only, so a reader never sees a half-written file. The
 * read→transform→write window is kept to a few milliseconds because every
 * other Claude Code process on the machine writes this file too; a targeted
 * RMW can still lose a write that lands inside that window, which is the
 * accepted cost of seeding trust without a private config dir (decision 0020).
 */
function writeClaudeJson(claudeJson: ClaudeJson): void {
  const path = claudeJsonPath()
  // pid + random suffix: unique even if two writes ever overlap in one process.
  const tmp = `${path}.itest-${process.pid}-${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, JSON.stringify(claudeJson))
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

/** Seed directory trust for `physPaths` into `~/.claude.json`. */
function seedTrust(physPaths: readonly string[]): void {
  writeClaudeJson(withTrustedPaths(readClaudeJson(), physPaths))
}

/** Drop the `projects` entries the harness seeded for `physPaths`. */
function unseedTrust(physPaths: readonly string[]): void {
  writeClaudeJson(withoutProjectPaths(readClaudeJson(), physPaths))
}

// --- the crash / interrupt safety net -------------------------------------
//
// The normal teardown is the async `Dispatcher.cleanup` an `afterAll` runs.
// If vitest is interrupted (Ctrl-C) or the process exits before that runs, a
// leaked teammate is an authenticated `claude` burning tokens and a leaked
// trust key sits in the user's `~/.claude.json`. This net does the same
// teardown synchronously — the only kind a signal/exit handler can do — so an
// interrupted run still cleans up after itself.

/** Per-dispatcher state the safety net needs to undo what a run leaked. */
interface DispatcherState {
  /** The temp dispatcher dir — `tm`'s `TM_DISPATCHER_DIR`. */
  dir: string
  /** Every repo name passed to `addRepo`, killed indiscriminately on cleanup. */
  repos: string[]
  /** Each fixture repo's physical path — the trust keys to unseed. */
  physPaths: string[]
}

/** Dispatchers with un-cleaned teammates — drained by `cleanup` or the net. */
const liveDispatchers = new Set<DispatcherState>()

let safetyNetInstalled = false
let netFired = false

/**
 * Synchronously tear down every still-live dispatcher: kill its teammates,
 * unseed its trust keys, and remove its transcript and temp directories. Runs
 * at most once — a normal `cleanup` drains `liveDispatchers`, so on a clean
 * run this is a no-op. Best-effort: every step is guarded, since a signal
 * handler must not throw. Unlike the async `cleanup` it cannot wait out a
 * dying teammate's last `~/.claude.json` write, so a rare inert trust key may
 * survive an interrupt — harmless, it points at a deleted dir (decision 0020).
 */
function cleanupAllSync(): void {
  if (netFired) return
  netFired = true
  for (const state of liveDispatchers) {
    for (const repo of state.repos) {
      try {
        execFileSync(resolveTmBinary(), ['kill', repo], {
          env: { ...process.env, TM_DISPATCHER_DIR: state.dir },
          stdio: 'ignore',
          timeout: 15_000,
        })
      } catch {
        // Best effort — a teammate that is already gone is the goal anyway.
      }
    }
    try {
      unseedTrust(state.physPaths)
    } catch {
      // A leftover inert trust key is harmless (decision 0020).
    }
    for (const phys of state.physPaths) {
      try {
        rmSync(join(homedir(), '.claude', 'projects', encodeProjectDir(phys)), {
          recursive: true,
          force: true,
        })
      } catch {
        // Best effort.
      }
    }
    try {
      rmSync(state.dir, { recursive: true, force: true })
    } catch {
      // Best effort.
    }
  }
  liveDispatchers.clear()
}

/** Install the crash / interrupt safety net exactly once. */
function installSafetyNet(): void {
  if (safetyNetInstalled) return
  safetyNetInstalled = true
  process.once('exit', cleanupAllSync)
  process.once('SIGINT', () => {
    cleanupAllSync()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    cleanupAllSync()
    process.exit(143)
  })
}

// --- the dispatcher fixture -----------------------------------------------

/**
 * How long `cleanup` waits, after killing a teammate, before it unseeds the
 * trust keys. A killed teammate's `claude` writes `~/.claude.json` once more
 * as it shuts down; unseeding before that write lands would just have it
 * re-add the `projects.<fixture-path>` entry. Waiting lets the unseed win.
 */
const SHUTDOWN_SETTLE_MS = 5_000

/** Resolve after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A temp dispatcher dir plus the teammate operations a live test runs on it. */
export interface Dispatcher {
  /** The dispatcher dir — passed to `tm` as `TM_DISPATCHER_DIR`. */
  readonly dir: string
  /**
   * Create a sibling repo subdirectory, seed its directory trust, and return
   * its **repo name** — the name to pass to `tm`. The name is made unique
   * (`claudemux-itest-<label>-<rand>`) because the tmux session it becomes
   * (`teammate-<repo>`) lives on the shared tmux server: a fixed name could
   * collide with — and the teardown would then kill — a real teammate.
   * `label` is a readability hint only; keep it to ASCII letters and digits,
   * since it becomes part of the fixture's filesystem path. The repo is not
   * spawned — that is a separate `tm spawn` call.
   */
  addRepo(label: string): string
  /** Run one `tm` verb against this dispatcher and capture its result. */
  tm(argv: readonly string[], options?: { stdin?: string }): Promise<TmOutcome>
  /**
   * Kill every teammate this dispatcher spawned, drop the project transcripts
   * they left under `~/.claude/projects`, unseed the trust keys, and remove
   * the temp dir. Safe to call once, in an `afterAll`.
   */
  cleanup(): Promise<void>
}

/**
 * Stand up a fresh dispatcher fixture: a unique temp directory that plays the
 * role of the parent-of-sibling-repos the dispatcher runs `tm` from.
 */
export function createDispatcher(): Dispatcher {
  installSafetyNet()
  // Fixture dirs go under /tmp, not os.tmpdir(). A teammate's project dir is
  // `encodeProjectDir(cwd)`, which folds only `/` and `.` to `-`. macOS's
  // os.tmpdir() — `/var/folders/<hash>/T` — carries underscores, and Claude
  // Code's own encoding folds `_` to `-` while `encodeProjectDir` leaves it,
  // so a teammate spawned there cannot be located by `tm resume`/`mem`/
  // `history`. /tmp resolves to an underscore-free path on macOS and Linux.
  const dir = mkdtempSync(join('/tmp', 'claudemux-itest-'))
  const state: DispatcherState = { dir, repos: [], physPaths: [] }
  liveDispatchers.add(state)

  const tm = async (
    argv: readonly string[],
    options?: { stdin?: string },
  ): Promise<TmOutcome> => {
    const result = await spawnCapture([resolveTmBinary(), ...argv], {
      env: { ...process.env, TM_DISPATCHER_DIR: dir },
      stdin: options?.stdin,
    })
    return { code: result.code, stdout: result.stdout, stderr: result.stderr }
  }

  return {
    dir,
    addRepo(label) {
      const name = `claudemux-itest-${label}-${randomBytes(3).toString('hex')}`
      const repoDir = join(dir, name)
      mkdirSync(repoDir, { recursive: true })
      // `tm` and `claude` both address the teammate by its physical path
      // (`cd && pwd -P`); trust and project-dir encoding key off that.
      const phys = realpathSync(repoDir)
      state.repos.push(name)
      state.physPaths.push(phys)
      seedTrust([phys])
      return name
    },
    tm,
    async cleanup() {
      // Kill teammates first — `tm kill` is a harmless no-op on a repo that
      // was never spawned or already died, so killing every added repo is
      // simpler and more reliable than tracking which ones went live.
      for (const repo of state.repos) {
        try {
          await tm(['kill', repo])
        } catch {
          // The repo is gone either way; the rm below still runs.
        }
      }
      // Let each killed teammate's shutdown write to ~/.claude.json land
      // before the unseed below, so the unseed is not raced and undone.
      if (state.repos.length > 0) await delay(SHUTDOWN_SETTLE_MS)
      // Drop the transcripts the teammates wrote under ~/.claude/projects —
      // `tm kill` does not, so without this each run leaks jsonl files
      // pointing at a deleted temp dir.
      for (const phys of state.physPaths) {
        rmSync(join(homedir(), '.claude', 'projects', encodeProjectDir(phys)), {
          recursive: true,
          force: true,
        })
      }
      try {
        unseedTrust(state.physPaths)
      } catch {
        // A failed unseed leaves inert trust keys for deleted temp dirs —
        // harmless, and not worth failing teardown over.
      }
      rmSync(dir, { recursive: true, force: true })
      liveDispatchers.delete(state)
    },
  }
}

// --- the live precondition probe ------------------------------------------

/** The verdict of `probeLiveTeammate` — whether the live suite can run here. */
export interface LiveProbe {
  /** True when a real teammate can be spawned and its hooks fire. */
  ok: boolean
  /** When `ok` is false, a one-line reason fit to print as the skip cause. */
  reason: string
}

/** Whether `argv` runs and exits zero — used to probe for `claude` / `tmux`. */
async function commandWorks(argv: readonly string[]): Promise<boolean> {
  try {
    return (await spawnCapture(argv)).code === 0
  } catch {
    return false
  }
}

/**
 * Decide whether the live-teammate suite can run on this machine.
 *
 * Checks, in order: `~/.claude.json` exists (the trust-seed target), `claude`
 * and `tmux` are on `PATH`, and — the real test — a throwaway `tm spawn`
 * produces a teammate whose SessionStart hook fires. That last check is what
 * proves the claudemux plugin is loaded for teammate sessions: `tm spawn`
 * prints a `ready:` line when the hook fired and a `WARN:` line when it did
 * not. The probe teammate takes no turn, so it costs a REPL boot, not tokens.
 */
export async function probeLiveTeammate(): Promise<LiveProbe> {
  try {
    if (!existsSync(claudeJsonPath())) {
      return {
        ok: false,
        reason: `${claudeJsonPath()} not found — Claude Code is not set up on this machine`,
      }
    }
    if (!(await commandWorks(['claude', '--version']))) {
      return { ok: false, reason: 'the `claude` CLI is not on PATH' }
    }
    if (!(await commandWorks(['tmux', '-V']))) {
      return { ok: false, reason: 'tmux is not on PATH' }
    }

    const dispatcher = createDispatcher()
    try {
      const probeRepo = dispatcher.addRepo('probe')
      const spawned = await dispatcher.tm(['spawn', probeRepo])
      if (spawned.code !== 0) {
        return {
          ok: false,
          reason: `tm spawn failed: ${spawned.stderr.trim() || spawned.stdout.trim()}`,
        }
      }
      if (!/^ready:/m.test(spawned.stderr)) {
        return {
          ok: false,
          reason:
            'a spawned teammate did not signal ready — the claudemux plugin/hooks ' +
            'are not loaded for teammate sessions (enable the claudemux plugin)',
        }
      }
      return { ok: true, reason: '' }
    } finally {
      await dispatcher.cleanup()
    }
  } catch (err) {
    // The probe must never reject: `hot-path.itest.ts` awaits it at module
    // scope, so a throw would abort vitest collection instead of skipping the
    // suite. A corrupt `~/.claude.json` — a torn concurrent write — lands here.
    return {
      ok: false,
      reason: `the live-teammate probe could not complete: ${
        err instanceof Error ? err.message : String(err)
      }`,
    }
  }
}
