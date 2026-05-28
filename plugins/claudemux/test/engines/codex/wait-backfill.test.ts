/**
 * Codex `tm wait` backfill — the `thread/read` snapshot path that lets a
 * follow-up `tm wait` recover a turn that completed in the gap between a
 * previous `tm send` timing out (124) and the new wait subscribing.
 *
 * Without this, the existing notification-only path silently drops any
 * turn that finished in [send-timeout, wait-subscribe], and the 124
 * contract — "still running, re-collect with tm wait" — would be a
 * race-broken promise on Codex. These tests pin the picker semantics
 * end-to-end so a future engine refactor that drops the read RPC or
 * mis-orders the filters fails loudly.
 *
 * The race-pattern (subscribe BEFORE read, race against backfill) is
 * tested separately by the live codex-engine suite where a fake daemon
 * speaks both notification and read RPCs; here we cover the pure
 * `pickBackfillTurn` semantics.
 */

import { describe, expect, test } from 'vitest'

import { pickBackfillTurn } from '../../../src/engines/codex/engine'
import type { Turn } from '../../../src/codex-protocol/v2/Turn'

function turn(overrides: Partial<Turn> & { id: string; status: Turn['status'] }): Turn {
  return {
    items: [],
    itemsView: 'notLoaded',
    error: null,
    startedAt: 0,
    completedAt: null,
    durationMs: null,
    ...overrides,
  } as Turn
}

describe('pickBackfillTurn', () => {
  const threadId = 'thr-1'

  test('happy path: one completed turn newer than lastSeen → backfilled', () => {
    const picked = pickBackfillTurn(
      [turn({ id: 't1', status: 'completed', completedAt: 1000 })],
      500,
      threadId,
    )
    expect(picked).not.toBeNull()
    expect(picked!.threadId).toBe(threadId)
    expect(picked!.turn.id).toBe('t1')
  })

  test('nothing newer than lastSeen → null (caller falls through to live subscription)', () => {
    const picked = pickBackfillTurn(
      [
        turn({ id: 't1', status: 'completed', completedAt: 100 }),
        turn({ id: 't2', status: 'completed', completedAt: 200 }),
      ],
      500,
      threadId,
    )
    expect(picked).toBeNull()
  })

  test('first-ever turn (lastSeen === 0) is backfilled', () => {
    // Daemon never recorded a `lastSeen` (touchLastSeen never ran) → the
    // wait verb passes 0 as the sentinel. Any completed turn qualifies.
    const picked = pickBackfillTurn(
      [turn({ id: 't1', status: 'completed', completedAt: 1 })],
      0,
      threadId,
    )
    expect(picked).not.toBeNull()
    expect(picked!.turn.id).toBe('t1')
  })

  test('failed turn IS backfilled — terminal status that turnNotificationToResult maps to exit 1', () => {
    // The next `tm wait` MUST see a late `failed` outcome, or it spins
    // to 124 on a turn that already settled into an error. The shared
    // `turnNotificationToResult` site then translates the failed status
    // to `{kind: "failed"}` → exit 1, identical to the live-notification
    // path. Skipping it here is the gap review-71 flagged.
    const picked = pickBackfillTurn(
      [turn({ id: 't1', status: 'failed', completedAt: 1000 })],
      500,
      threadId,
    )
    expect(picked).not.toBeNull()
    expect(picked!.turn.id).toBe('t1')
    expect(picked!.turn.status).toBe('failed')
  })

  test('interrupted turn IS backfilled — terminal status, same exit-1 mapping as live notifications', () => {
    const picked = pickBackfillTurn(
      [turn({ id: 't1', status: 'interrupted', completedAt: 1000 })],
      500,
      threadId,
    )
    expect(picked).not.toBeNull()
    expect(picked!.turn.id).toBe('t1')
    expect(picked!.turn.status).toBe('interrupted')
  })

  test('inProgress is the only status skipped — live subscription will deliver it', () => {
    const picked = pickBackfillTurn(
      [turn({ id: 't1', status: 'inProgress', completedAt: null })],
      500,
      threadId,
    )
    expect(picked).toBeNull()
  })

  test('terminal-status max-completedAt scan compares across statuses, not just within one', () => {
    // Snapshot carries all three terminal statuses; the picker MUST
    // order them on `completedAt` alone, not bias toward one status.
    // A late `failed` shadowed by an older `completed` (or vice versa)
    // would otherwise silently deliver the wrong terminal state and the
    // dispatcher would act on a stale outcome.
    const picked = pickBackfillTurn(
      [
        turn({ id: 'older-completed', status: 'completed', completedAt: 600 }),
        turn({ id: 'newest-failed', status: 'failed', completedAt: 900 }),
        turn({ id: 'middle-interrupted', status: 'interrupted', completedAt: 700 }),
      ],
      500,
      threadId,
    )
    expect(picked).not.toBeNull()
    expect(picked!.turn.id).toBe('newest-failed')
    expect(picked!.turn.status).toBe('failed')
  })

  test('completed turn with null completedAt is skipped (cannot be ordered against lastSeen)', () => {
    const picked = pickBackfillTurn(
      [turn({ id: 't1', status: 'completed', completedAt: null })],
      500,
      threadId,
    )
    expect(picked).toBeNull()
  })

  test('picks max completedAt when multiple turns qualify (snapshot order is not contractual)', () => {
    const picked = pickBackfillTurn(
      [
        turn({ id: 'older', status: 'completed', completedAt: 600 }),
        turn({ id: 'newest', status: 'completed', completedAt: 900 }),
        turn({ id: 'middle', status: 'completed', completedAt: 700 }),
      ],
      500,
      threadId,
    )
    expect(picked).not.toBeNull()
    expect(picked!.turn.id).toBe('newest')
  })

  test('itemsView synthesis matches subscribeTurnCollection convention', () => {
    // A backfill turn with populated items reads as 'full'; the
    // downstream turnNotificationToResult flattens items the same way
    // it does for live notifications, so the contract is one-shape-fits-both.
    const withItems = pickBackfillTurn(
      [
        turn({
          id: 't1',
          status: 'completed',
          completedAt: 1000,
          items: [{ id: 'i1', type: 'reasoning', text: '…' } as never],
        }),
      ],
      0,
      threadId,
    )
    expect(withItems!.turn.itemsView).toBe('full')

    const empty = pickBackfillTurn(
      [turn({ id: 't1', status: 'completed', completedAt: 1000, items: [] })],
      0,
      threadId,
    )
    expect(empty!.turn.itemsView).toBe('notLoaded')
  })

  test('lastSeen boundary is strictly greater (a turn whose completedAt equals lastSeen is treated as already-seen)', () => {
    // Prevents redelivery on a repeat `tm wait`: after a successful wait,
    // touchLastSeen writes nowSec(), and a re-run within the same second
    // must not re-surface the same turn.
    const picked = pickBackfillTurn(
      [turn({ id: 't1', status: 'completed', completedAt: 500 })],
      500,
      threadId,
    )
    expect(picked).toBeNull()
  })
})
