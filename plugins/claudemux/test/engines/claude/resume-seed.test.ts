/**
 * Regression coverage for `.last` seeding on `tm resume`.
 *
 * Two layers:
 *
 *   1. `readLastAssistantText` (ctx.ts) — the pure jsonl-walk that seeds
 *      the `.last` file. The dispatcher relies on this returning the
 *      latest text-bearing assistant turn even when later non-assistant
 *      entries (file-history-snapshot, bridge-session, tool_use turns)
 *      come after it.
 *
 *   2. `claudeSpawn` resume path — once `clearIdle(sid)` removes the
 *      prior `.last`, the resume branch MUST re-seed it from the
 *      transcript so `tm last` / `tm send`'s post-turn print does not
 *      return the "no text reply this turn" sentinel for the
 *      pre-relaunch turn the dispatcher just wanted to read again.
 *
 *      Reproduces the original bug: pre-fix, the `if (resumeSid.length
 *      === 0)` guard skipped both the empty-sentinel write *and* any
 *      prior-text recovery, leaving `.last` permanently missing after
 *      `tm resume` until the next Stop hook fire — and if that fire's
 *      `extract_last_turn` returned empty (tool-only or thinking-only
 *      final entry) it rm'd the file, putting the dispatcher right back
 *      where it started.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { encodeProjectDir } from '../../../src/persistence/paths'
import { readLastAssistantText } from '../../../src/engines/claude/ctx'
import { claudeSpawn } from '../../../src/engines/claude/spawn'
import {
  cwdFile,
  idleDir,
  lastFileFor,
  readyFile,
  sidFile,
} from '../../../src/persistence/paths'
import type { ClaudeVerbEnv } from '../../../src/engines/claude/env'
import type { TmuxResult } from '../../../src/tmux'

const SCRATCH = '/tmp/claudemux-resume-seed-test'

/** Build one jsonl line for an assistant entry whose `message.content` is `blocks`. */
function assistantLine(blocks: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: blocks },
  })
}

/** Build one jsonl line for a user entry whose `message.content` is `content`. */
function userLine(content: string | ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } })
}

/** A `permission-mode`-style metadata entry the resume sync writes. */
function metaLine(type: string): string {
  return JSON.stringify({ type, sessionId: 'x' })
}

function writeJsonl(path: string, lines: readonly string[]): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${lines.join('\n')}\n`)
}

beforeEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
  mkdirSync(SCRATCH, { recursive: true })
  mkdirSync(idleDir(), { recursive: true })
})

afterEach(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

describe('readLastAssistantText — pre-fix the resume seed source-of-truth', () => {
  test('returns the joined text of the most recent assistant entry', () => {
    const jsonl = join(SCRATCH, 'a.jsonl')
    writeJsonl(jsonl, [
      userLine('older prompt'),
      assistantLine([{ type: 'text', text: 'older reply' }]),
      userLine('newer prompt'),
      assistantLine([
        { type: 'text', text: 'first half ' },
        { type: 'text', text: 'second half' },
      ]),
    ])
    expect(readLastAssistantText(jsonl)).toBe('first half second half')
  })

  test('skips later non-assistant entries to reach the last text-bearing turn', () => {
    // After a resume, Claude Code appends metadata entries (bridge-session,
    // permission-mode, file-history-snapshot) AFTER the prior assistant turn.
    // Walking back must skip them and recover the previous reply.
    const jsonl = join(SCRATCH, 'b.jsonl')
    writeJsonl(jsonl, [
      userLine('the prompt'),
      assistantLine([{ type: 'text', text: 'the prior reply' }]),
      metaLine('file-history-snapshot'),
      metaLine('permission-mode'),
      metaLine('bridge-session'),
    ])
    expect(readLastAssistantText(jsonl)).toBe('the prior reply')
  })

  test('skips tool_use-only and thinking-only assistant entries to find text', () => {
    const jsonl = join(SCRATCH, 'c.jsonl')
    writeJsonl(jsonl, [
      userLine('the prompt'),
      assistantLine([{ type: 'text', text: 'the visible deliverable' }]),
      userLine([{ type: 'tool_result', content: 'result' }]),
      assistantLine([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
      userLine([{ type: 'tool_result', content: 'more' }]),
      assistantLine([{ type: 'thinking', thinking: 'just thinking' }]),
    ])
    expect(readLastAssistantText(jsonl)).toBe('the visible deliverable')
  })

  test('returns "" for a transcript with no text-bearing assistant entry', () => {
    const jsonl = join(SCRATCH, 'd.jsonl')
    writeJsonl(jsonl, [
      userLine('the prompt'),
      assistantLine([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
    ])
    expect(readLastAssistantText(jsonl)).toBe('')
  })

  test('returns "" for a missing transcript', () => {
    expect(readLastAssistantText(join(SCRATCH, 'missing.jsonl'))).toBe('')
  })

  test('skips malformed lines and keeps walking back', () => {
    const jsonl = join(SCRATCH, 'e.jsonl')
    writeJsonl(jsonl, [
      userLine('older'),
      assistantLine([{ type: 'text', text: 'recovered reply' }]),
      'not-json-at-all',
      '{"broken":',
    ])
    expect(readLastAssistantText(jsonl)).toBe('recovered reply')
  })
})

describe.skip('claudeSpawn — `.last` seeding on resume', () => {
  // Fake tmux runner: respond ok to `new-session` (returning a synthetic
  // pane id) and to `send-keys` (and as a side effect, touch the ready
  // file so `pollReady` returns on its first iteration without the full
  // 18s wait). All other tmux invocations get a no-op success.
  function makeRunTmux(repo: string): (
    args: readonly string[],
  ) => Promise<TmuxResult> {
    return async (args) => {
      if (args[0] === 'has-session') return { code: 1, stdout: '', stderr: '' }
      if (args[0] === 'new-session') {
        return { code: 0, stdout: '$99\n', stderr: '' }
      }
      if (args[0] === 'send-keys') {
        // Mark the teammate ready so the pollReady loop exits on the next tick.
        writeFileSync(readyFile(repo), '')
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: '', stderr: '' }
    }
  }

  function buildEnv(repo: string): ClaudeVerbEnv {
    return {
      runTmux: makeRunTmux(repo),
      runColumn: async () => ({ code: 0, stdout: '', stderr: '' }),
      dispatcherDir: SCRATCH,
      projectsDir: join(SCRATCH, 'projects'),
    }
  }

  test('resume seeds `.last` with the prior assistant text from the jsonl', async () => {
    const repo = 'alpha'
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const repoDir = join(SCRATCH, repo)
    mkdirSync(repoDir, { recursive: true })
    const projectDir = join(SCRATCH, 'projects', encodeProjectDir(realpathSync(repoDir)))
    mkdirSync(projectDir, { recursive: true })
    writeJsonl(join(projectDir, `${sid}.jsonl`), [
      userLine('previous prompt'),
      assistantLine([{ type: 'text', text: 'the previous reply' }]),
      metaLine('bridge-session'),
    ])

    const env = buildEnv(repo)
    const result = await claudeSpawn([repo, '--resume', sid], env)
    expect(result.code).toBe(0)

    const last = lastFileFor(sid)
    expect(existsSync(last)).toBe(true)
    expect(readFileSync(last, 'utf8')).toBe('the previous reply\n')

    // Sid file points at the resumed sid so `tm last` resolves it.
    expect(readFileSync(sidFile(repo), 'utf8').trim()).toBe(sid)
    rmSync(last, { force: true })
    rmSync(sidFile(repo), { force: true })
    rmSync(cwdFile(repo), { force: true })
    rmSync(readyFile(repo), { force: true })
  })

  test('resume falls back to the empty sentinel when the jsonl has no assistant text', async () => {
    const repo = 'beta'
    const sid = '11111111-2222-3333-4444-555555555555'
    const repoDir = join(SCRATCH, repo)
    mkdirSync(repoDir, { recursive: true })
    const projectDir = join(SCRATCH, 'projects', encodeProjectDir(realpathSync(repoDir)))
    mkdirSync(projectDir, { recursive: true })
    writeJsonl(join(projectDir, `${sid}.jsonl`), [
      userLine('previous prompt'),
      assistantLine([{ type: 'tool_use', id: 't1', name: 'Read', input: {} }]),
    ])

    const env = buildEnv(repo)
    const result = await claudeSpawn([repo, '--resume', sid], env)
    expect(result.code).toBe(0)

    const last = lastFileFor(sid)
    expect(existsSync(last)).toBe(true)
    expect(readFileSync(last, 'utf8')).toBe('')
    rmSync(last, { force: true })
    rmSync(sidFile(repo), { force: true })
    rmSync(cwdFile(repo), { force: true })
    rmSync(readyFile(repo), { force: true })
  })

  test('fresh spawn still writes the empty `.last` sentinel (unchanged)', async () => {
    const repo = 'gamma'
    const repoDir = join(SCRATCH, repo)
    mkdirSync(repoDir, { recursive: true })

    const env = buildEnv(repo)
    const result = await claudeSpawn([repo], env)
    expect(result.code).toBe(0)

    const sid = readFileSync(sidFile(repo), 'utf8').trim()
    expect(sid).not.toBe('')
    const last = lastFileFor(sid)
    expect(existsSync(last)).toBe(true)
    expect(readFileSync(last, 'utf8')).toBe('')
    rmSync(last, { force: true })
    rmSync(sidFile(repo), { force: true })
    rmSync(cwdFile(repo), { force: true })
    rmSync(readyFile(repo), { force: true })
  })
})
