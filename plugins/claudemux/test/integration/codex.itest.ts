/**
 * Live-codex integration suite — the codex driver's counterpart to
 * `hot-path.itest.ts` (which exercises the Claude tmux+hooks driver).
 *
 * The conformance harness fakes everything; the unit suites fake the codex
 * daemon with a node shim that speaks a minimal protocol subset. The real
 * protocol-layer behavior — and the supervision substrate the verbs sit on —
 * only proves out against a real `codex app-server`. This suite drives that
 * case.
 *
 * What's pinned here is split into two slices:
 *
 *   - **Smoke** — spawn the daemon, observe `tm doctor` reports it,
 *     kill it, observe the registry directory torn down. No turns.
 *     Costs ~half a second of process startup; no model usage.
 *   - **Turn-spending** — `tm send <codex-name> --prompt "..."` against the
 *     real model and `tm ask "..."` against the pool. Each turn costs
 *     a small amount of OpenAI credits, so the gate
 *     `CLAUDEMUX_CODEX_SPEND_TOKENS=1` keeps them opt-in even within
 *     the (already opt-in) integration config.
 *
 * Run it explicitly (never via `npm test`):
 *
 *   cd plugins/claudemux
 *   npx vitest run --config vitest.integration.config.ts test/integration/codex.itest.ts
 *
 * Add `CLAUDEMUX_CODEX_SPEND_TOKENS=1` to also run the turn-spending
 * slice.
 *
 * The suite **skips itself** when codex is not installed or
 * `~/.codex/auth.json` is missing — running it must never accidentally
 * fail a local dev box that does not have codex set up.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { isProcessAlive, killProcessGroup } from '../../src/engines/codex/supervisor'
import { resolveTmBinary } from '../../src/tm'
import { spawnCapture } from '../../src/proc'

interface CodexProbe {
  ok: boolean
  reason: string
  binPath: string
}

async function probeCodexLive(): Promise<CodexProbe> {
  const binPath = process.env['CLAUDEMUX_CODEX_BIN'] ?? 'codex'
  try {
    const ver = await spawnCapture([binPath, '--version'])
    if (ver.code !== 0) {
      return { ok: false, reason: `'${binPath} --version' exited ${ver.code}`, binPath }
    }
  } catch (e) {
    return {
      ok: false,
      reason: `'${binPath}' is not on PATH (${(e as Error).message})`,
      binPath,
    }
  }
  const authPath = join(homedir(), '.codex', 'auth.json')
  if (!existsSync(authPath)) {
    return {
      ok: false,
      reason: `${authPath} not found — codex is not signed in on this machine`,
      binPath,
    }
  }
  return { ok: true, reason: '', binPath }
}

const probe = await probeCodexLive()
if (!probe.ok) {
  console.warn(`[integration] skipping live-codex suite — ${probe.reason}`)
}

const tmBin = resolveTmBinary()

// Per-suite registry root so the live tests never touch the user's
// production `/tmp/teammate-codex/` (which may hold real teammates).
// Each spawn under this root lives at `<root>/<name>/socket` — the
// short `/tmp/cmxlive-*` prefix keeps the unix socket path under macOS's
// ~104-char limit.
let registryRoot: string
let identityRoot: string
let savedRegistryRoot: string | undefined
let savedIdentityRoot: string | undefined

beforeAll(() => {
  registryRoot = mkdtempSync('/tmp/cmxlive-')
  identityRoot = mkdtempSync('/tmp/cmxlive-id-')
  savedRegistryRoot = process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
  savedIdentityRoot = process.env['CLAUDEMUX_IDENTITY_ROOT']
  process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = registryRoot
  process.env['CLAUDEMUX_IDENTITY_ROOT'] = identityRoot
})

afterAll(() => {
  // Belt-and-suspenders teardown safety net. The dispatcher hit 11
  // leaked codex daemons during stage 4 dogfooding because
  // single-pid reap (now fixed in the supervisor) orphaned the
  // wrapper's child. The supervisor fix means `tm kill` is now
  // correct, but a test that throws mid-execution can still leave a
  // registry entry whose `pid` points at a live process group.
  // Scan the test's registry root, group-kill any surviving leaders,
  // then remove the tree.
  try {
    if (existsSync(registryRoot)) {
      for (const name of readdirSync(registryRoot)) {
        const pidFile = join(registryRoot, name, 'pid')
        let pid: number | null = null
        try {
          pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
        } catch {
          pid = null
        }
        if (pid !== null && Number.isFinite(pid) && pid > 0) {
          // Always group-kill, even if the leader looks dead — an
          // orphan child can still be holding the socket.
          killProcessGroup(pid, 'SIGKILL')
          if (isProcessAlive(pid)) {
            // Should not happen after group-kill, but if it does we
            // surface a stronger signal than "test passed but leaked".
            console.warn(`[teardown] leader pid ${pid} (${name}) survived SIGKILL`)
          }
        }
      }
    }
  } finally {
    if (savedRegistryRoot === undefined) delete process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT']
    else process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] = savedRegistryRoot
    if (savedIdentityRoot === undefined) delete process.env['CLAUDEMUX_IDENTITY_ROOT']
    else process.env['CLAUDEMUX_IDENTITY_ROOT'] = savedIdentityRoot
    rmSync(registryRoot, { recursive: true, force: true })
    rmSync(identityRoot, { recursive: true, force: true })
  }
})

/**
 * Invoke `tm` through the resolved launcher with the same env override
 * the test suite set up. `env` is merged on top of `process.env`.
 */
async function tm(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return spawnCapture([tmBin, ...args], { env: process.env as Record<string, string> })
}

describe.skipIf(!probe.ok)('live codex driver — smoke (no turn spend)', () => {
  const name = 'codex-itest-smoke'

  test('tm spawn brings up a real codex daemon under the test registry root', async () => {
    const result = await tm(['spawn', name, '--engine', 'codex'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stderr).toMatch(new RegExp(`^spawned: ${name} \\(pid=\\d+, socket=${registryRoot}/${name}/socket\\)\\n$`))
    expect(existsSync(`${registryRoot}/${name}/socket`)).toBe(true)
    expect(existsSync(`${registryRoot}/${name}/pid`)).toBe(true)
  })

  test('tm doctor lists the live daemon under "codex teammates"', async () => {
    const result = await tm(['doctor'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toContain('codex teammates:')
    expect(result.stdout).toContain(name)
    expect(result.stdout).not.toMatch(/reaped orphans/)
  })

  test('tm doctor reaps a dead-pid orphan', async () => {
    // Manually kill the daemon process; the registry directory now
    // points at a dead pid. `tm doctor` should reap it on the next pass.
    const pidStr = (await spawnCapture(['cat', `${registryRoot}/${name}/pid`])).stdout.trim()
    const pid = Number.parseInt(pidStr, 10)
    process.kill(pid, 'SIGKILL')
    await new Promise((res) => setTimeout(res, 250))

    const result = await tm(['doctor'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/reaped orphans/)
    expect(result.stdout).toContain(name)
    expect(existsSync(`${registryRoot}/${name}`)).toBe(false)
  })

  test('tm kill on an already-gone teammate reports not running', async () => {
    const result = await tm(['kill', name])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout).toBe(`not running: ${name}\n`)
  })
})

// The turn-spending slice. Skipped by default so a routine `--config`
// run cannot accidentally spend credits — set
// `CLAUDEMUX_CODEX_SPEND_TOKENS=1` to opt in. The assertions stay
// permissive — exact reply text is the model's call, not ours — and only
// pin contract-level facts: the round-trip completed, stdout is not a raw
// Turn dump, raw JSON is available on demand, the borrow lock came and
// went, the daemon survived the call.
const spendsTokens = process.env['CLAUDEMUX_CODEX_SPEND_TOKENS'] === '1'

describe.skipIf(!probe.ok || !spendsTokens)('live codex driver — turn-spending (opt-in)', () => {
  const name = 'codex-itest-turns'

  beforeAll(async () => {
    const spawned = await tm(['spawn', name, '--engine', 'codex'])
    expect(spawned.code, spawned.stderr).toBe(0)
  })

  afterAll(async () => {
    await tm(['kill', name])
  })

  test('tm send drives one turn, prints reply text, and stores raw Turn JSON out-of-band', async () => {
    const result = await tm(['send', name, '--prompt', 'Reply with the single word: PONG.'])
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim().length).toBeGreaterThan(0)
    expect(result.stdout).not.toMatch(/^\s*\{\s*"threadId"/)
    expect(result.stderr).toContain(`sent to ${name} (codex)\n`)
    expect(result.stderr).toMatch(/^sid=[0-9a-f-]+$/m)
    expect(result.stderr).toContain(`raw: ${registryRoot}/${name}/last-turn.json\n`)
    const raw = await tm(['last', name, '--verbose'])
    expect(raw.code, raw.stderr).toBe(0)
    const parsed = JSON.parse(raw.stdout) as Record<string, unknown>
    expect(parsed['threadId']).toBeTypeOf('string')
    expect(parsed['turn']).toBeTypeOf('object')
  }, 60000)

  test('a second tm send reuses the persisted thread id', async () => {
    const before = (await spawnCapture(['cat', resolve(registryRoot, name, 'thread')])).stdout.trim()
    expect(before.length).toBeGreaterThan(0)
    const result = await tm(['send', name, '--prompt', 'Reply with: GOOSE.'])
    expect(result.code, result.stderr).toBe(0)
    const after = (await spawnCapture(['cat', resolve(registryRoot, name, 'thread')])).stdout.trim()
    expect(after).toBe(before)
  }, 60000)

  test('tm ask borrows the teammate, runs a turn, returns it (lock cleaned, thread restored)', async () => {
    const beforeThread = (await spawnCapture(['cat', resolve(registryRoot, name, 'thread')])).stdout.trim()
    const result = await tm(['ask', 'Reply with: CARROT.'])
    expect(result.code, result.stderr).toBe(0)
    expect(existsSync(resolve(registryRoot, name, 'lock'))).toBe(false)
    const afterThread = (await spawnCapture(['cat', resolve(registryRoot, name, 'thread')])).stdout.trim()
    expect(afterThread).toBe(beforeThread)
  }, 60000)
})

// Silence unused-import warning when the suite is fully skipped.
void dirname
void fileURLToPath
