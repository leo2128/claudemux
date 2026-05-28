/**
 * Live-teammate integration suite for the hot-path verbs.
 *
 * `spawn`, `send`, `wait`, `compact`, and `resume` are racy: their behavior is
 * the interaction of `tmux send-keys`, a real `claude` REPL, the claudemux
 * hooks, and the `/tmp/claude-idle` turn signal. The conformance harness fakes
 * tmux and runs no `claude`, so it cannot pin them — this suite does, by
 * driving a real teammate end to end.
 *
 * It is opt-in and slow: each `test` below is a real Claude Code turn. They
 * run as an **ordered lifecycle against one shared teammate** — spawn it,
 * message it, wait on it, compact it, resume it — because a fresh teammate per
 * assertion would multiply the cost for no extra coverage. vitest runs the
 * tests in a file in source order; the integration config keeps files
 * non-parallel.
 *
 * Run it explicitly (never via `npm test`):
 *   npx vitest run --config vitest.integration.config.ts
 * See `test/integration/README.md` for prerequisites.
 *
 * ## What is asserted, and what is not
 *
 * These tests assert the verb **contract** — the round-trip completes (exit 0,
 * the turn's Stop signal fired within `--timeout`), the prompt was sent, the
 * output is well-formed — not the exact reply text. `tm`'s last-turn capture
 * (`<sid>.last`) is lossy by design: when the hook's extraction races a
 * still-flushing transcript it leaves `.last` empty and the verb prints the
 * documented sentinel `(no text reply this turn — …)` instead of the reply
 * (see the domain spec's note on the lossy turn signal). A reply-text
 * assertion would therefore flake; each prompt asks for a unique token and the
 * test accepts the token *or* that sentinel — both are valid `tm` outputs; a
 * timeout or a crash is not. Every assertion carries `tmDetail`, so a live
 * failure shows `tm`'s own stdout/stderr.
 */

import { readFileSync } from 'node:fs'

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { sidFile } from '../../src/persistence/paths'
import { createDispatcher, probeLiveTeammate, tmDetail, type Dispatcher } from './harness'

// Decide up front whether a real teammate can run here. The probe spawns one
// throwaway teammate (no turn), so this costs a REPL boot at collection time.
const probe = await probeLiveTeammate()
if (!probe.ok) {
  console.warn(`[integration] skipping live-teammate suite — ${probe.reason}`)
}

/**
 * Whether `stdout` is a valid `send`/`wait` round-trip result — it carries the
 * reply (with `token`) or `tm`'s documented empty-turn sentinel. A plain
 * substring test, not a regex: `token` is content, never a pattern. Only a
 * timeout or a crash fails the verb.
 */
function repliedOrSentinel(stdout: string, token: string): boolean {
  return stdout.includes(token) || stdout.includes('no text reply this turn')
}

describe.skipIf(!probe.ok)('hot-path verbs drive a live Claude teammate', () => {
  let dispatcher: Dispatcher
  /** The unique repo name the whole lifecycle runs against. */
  let repo: string

  beforeAll(() => {
    dispatcher = createDispatcher()
    repo = dispatcher.addRepo('alpha')
  })

  afterAll(async () => {
    await dispatcher.cleanup()
  })

  test('spawn — launches a teammate whose SessionStart hook fires', async () => {
    const spawned = await dispatcher.tm(['spawn', repo])
    expect(spawned.code, tmDetail('tm spawn', spawned)).toBe(0)
    // `ready:` (not the `WARN:` line) proves the SessionStart hook fired.
    expect(spawned.stderr, tmDetail('tm spawn', spawned)).toMatch(/^ready:/m)

    const listed = await dispatcher.tm(['ls'])
    expect(listed.code, tmDetail('tm ls', listed)).toBe(0)
    expect(listed.stdout, tmDetail('tm ls', listed)).toContain(`teammate-${repo}`)
  })

  test('send — round-trips a prompt and returns a well-formed reply', async () => {
    const sent = await dispatcher.tm([
      'send',
      repo,
      '--prompt',
      'Reply with the word PONG.',
      '--timeout',
      '120',
    ])
    expect(sent.code, tmDetail('tm send', sent)).toBe(0)
    expect(sent.stderr, tmDetail('tm send', sent)).toContain(`sent to ${repo}`)
    expect(repliedOrSentinel(sent.stdout, 'PONG'), tmDetail('tm send', sent)).toBe(true)
  })

  test('send — a second turn builds transcript for compact', async () => {
    const sent = await dispatcher.tm([
      'send',
      repo,
      '--prompt',
      'Reply with the word ROGER.',
      '--timeout',
      '120',
    ])
    expect(sent.code, tmDetail('tm send', sent)).toBe(0)
    expect(repliedOrSentinel(sent.stdout, 'ROGER'), tmDetail('tm send', sent)).toBe(true)
  })

  test.skip('wait — collects a turn driven by an external actor (post --no-wait removal)', async () => {
    // The pre-removal version drove a fire-and-forget turn via
    // `tm send --no-wait` and collected it with a bare `tm wait`. With
    // `--no-wait` gone, the CLI has no first-class fire-and-forget
    // primitive — the test needs a redesign (detached subprocess, or a
    // helper that pushes keys directly through tmux).
    //
    // Follow-up strategy: add an integration-harness-only external actor
    // helper that writes to the teammate pane without calling `tm send`, then
    // keep this assertion scoped to `tm wait` observing that independent turn.
  })

  test('compact — runs /compact and verifies it completed', async () => {
    const compacted = await dispatcher.tm(['compact', repo, '--timeout', '180'])
    expect(compacted.code, tmDetail('tm compact', compacted)).toBe(0)
    expect(compacted.stdout, tmDetail('tm compact', compacted)).toContain('compacted')
  })

  test('resume — relaunches a killed conversation and drives a turn', async () => {
    // `tm kill` removes the .sid file, so capture the sid before killing.
    const sid = readFileSync(sidFile(repo), 'utf8').trim()
    expect(sid).not.toBe('')

    const killed = await dispatcher.tm(['kill', repo])
    expect(killed.code, tmDetail('tm kill', killed)).toBe(0)

    const resumed = await dispatcher.tm(['resume', repo, sid])
    expect(resumed.code, tmDetail('tm resume', resumed)).toBe(0)
    expect(resumed.stderr, tmDetail('tm resume', resumed)).toMatch(/resumed sid=/)

    const sent = await dispatcher.tm([
      'send',
      repo,
      '--prompt',
      'Reply with the word BACK.',
      '--timeout',
      '120',
    ])
    expect(sent.code, tmDetail('tm send', sent)).toBe(0)
    expect(repliedOrSentinel(sent.stdout, 'BACK'), tmDetail('tm send', sent)).toBe(true)
  })
})
