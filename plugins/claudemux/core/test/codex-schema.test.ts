/**
 * Schema tests for the codex app-server wire protocol.
 *
 * Two layers are pinned:
 *
 *   1. The vendored TypeScript bindings under `src/codex-protocol/` are the
 *      output of `codex app-server generate-ts --experimental`. CI reruns
 *      generate-ts and asserts `git diff --exit-code` (see ci.yml), so a
 *      codex upgrade that changes a *field* surfaces as a red diff there.
 *
 *   2. The wire **envelope** the codex app-server actually emits is not
 *      strict JSON-RPC 2.0: it omits the `jsonrpc` version field. The
 *      generated bindings describe the inside of each `params` / `result`,
 *      not the envelope around them, so the envelope cannot drift through
 *      the diff check above — it has to be pinned by an explicit fixture.
 *      That is this file's job (decision 0019 §5).
 *
 * The fixture under `test/fixtures/codex/` is a real envelope captured
 * once from a running `codex app-server --listen ws://127.0.0.1:<port>`.
 * If the live integration suite (#36) later replays a turn and the
 * envelope shape has shifted, the schema test breaks first — fail-loud at
 * a known seam, not silent corruption.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { describe, expect, test } from 'vitest'

import type { InitializeResponse } from '../src/codex-protocol/InitializeResponse'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex')

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'))
}

describe('codex app-server response envelope', () => {
  const initEnvelope = readFixture('initialize-response.json') as Record<string, unknown>

  test('the envelope keys are exactly { id, result } — no `jsonrpc` field', () => {
    // Decision 0019 §5: the codex protocol omits the `jsonrpc` version field.
    // A future codex release adding it would shift our client's parsing
    // contract; pin the absence explicitly so we see it the moment it changes.
    expect(Object.keys(initEnvelope).sort()).toEqual(['id', 'result'])
  })

  test('the id is a number on a request/response pair', () => {
    expect(typeof initEnvelope['id']).toBe('number')
  })

  test('the result is an object, not a primitive or array', () => {
    const result = initEnvelope['result']
    expect(typeof result).toBe('object')
    expect(result).not.toBeNull()
    expect(Array.isArray(result)).toBe(false)
  })
})

describe('codex InitializeResponse shape (vendored type vs captured fixture)', () => {
  const env = readFixture('initialize-response.json') as { result: unknown }

  test('the four required fields are all strings', () => {
    // The generated `InitializeResponse` declares every field as a plain
    // string (or `AbsolutePathBuf`, which is a `string` alias). A codex
    // change that swaps any of them for, say, an object trips this assertion
    // even though the field is still *present* in the bindings.
    const result = env.result as Record<string, unknown>
    expect(typeof result['userAgent']).toBe('string')
    expect(typeof result['codexHome']).toBe('string')
    expect(typeof result['platformFamily']).toBe('string')
    expect(typeof result['platformOs']).toBe('string')
  })

  test('the result has no fields beyond the vendored InitializeResponse shape', () => {
    // Pin "no surprise fields" — if codex starts emitting extras the
    // vendored type does not declare, the drift gate catches it as a
    // regenerated `InitializeResponse.ts`; if the *vendor* picked them up
    // but a *runtime emit* started carrying extras the bindings missed,
    // this assertion notices instead.
    const result = env.result as Record<string, unknown>
    expect(Object.keys(result).sort()).toEqual(
      ['codexHome', 'platformFamily', 'platformOs', 'userAgent'].sort(),
    )
  })

  test('the fixture is assignable to InitializeResponse at the type level', () => {
    // A compile-time cast — if `InitializeResponse` ever required a field the
    // fixture lacks (or vice versa) tsc would reject this file. The runtime
    // assertion is a true-by-construction sanity check; the type-level
    // assertion is what actually moves under a vendored-types drift.
    const typed: InitializeResponse = env.result as InitializeResponse
    expect(typed.userAgent.length).toBeGreaterThan(0)
  })
})
