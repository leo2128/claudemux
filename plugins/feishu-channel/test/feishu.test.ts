/**
 * Unit tests for the pure decoders exported from `src/feishu.ts`.
 *
 * `createFeishuTransport` itself needs a live Feishu app and is not unit
 * tested (see `test/feishu-live.ts`); the response-shaping logic it depends
 * on is pulled into pure functions so it can be covered here without one.
 */

import { describe, expect, test } from 'bun:test'
import { commentFromBatchQuery } from '../src/feishu'

/**
 * One `drive.v1.fileComment.batchQuery` response item, in the exact shape the
 * live API returns — a local-selection comment (`is_whole: false`) anchored to
 * a quote, with one reply. Captured from a real `batch_query` response.
 */
function batchQueryItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    comment_id: 'cmt_1',
    is_whole: false,
    quote: 'the target sentence the comment is anchored to',
    reply_list: {
      replies: [
        {
          reply_id: 'rpl_1',
          user_id: 'ou_commenter',
          content: { elements: [{ type: 'text_run', text_run: { text: 'please take a look' } }] },
        },
      ],
    },
    ...overrides,
  }
}

describe('commentFromBatchQuery', () => {
  test('decodes a local-selection comment with its quote and reply text', () => {
    const comment = commentFromBatchQuery([batchQueryItem()], 'cmt_1')

    expect(comment).toEqual({
      isWhole: false,
      quote: 'the target sentence the comment is anchored to',
      replies: [
        {
          replyId: 'rpl_1',
          authorId: 'ou_commenter',
          elements: [{ type: 'text_run', text_run: { text: 'please take a look' } }],
        },
      ],
    })
  })

  test('picks the requested comment out of a multi-item response', () => {
    const items = [
      batchQueryItem({ comment_id: 'cmt_other', quote: 'a different anchor' }),
      batchQueryItem({ comment_id: 'cmt_1', quote: 'the wanted anchor' }),
    ]
    expect(commentFromBatchQuery(items, 'cmt_1')?.quote).toBe('the wanted anchor')
  })

  test('returns null when the response carries no comment with that id', () => {
    expect(commentFromBatchQuery([batchQueryItem({ comment_id: 'cmt_other' })], 'cmt_1')).toBeNull()
  })

  test('returns null for an empty response', () => {
    expect(commentFromBatchQuery([], 'cmt_1')).toBeNull()
  })

  test('a whole-document comment decodes with isWhole true and an empty quote', () => {
    const comment = commentFromBatchQuery(
      [batchQueryItem({ is_whole: true, quote: '' })],
      'cmt_1',
    )
    expect(comment?.isWhole).toBe(true)
    expect(comment?.quote).toBe('')
  })

  test('defaults isWhole to true and quote to empty when the API omits them', () => {
    const comment = commentFromBatchQuery(
      [{ comment_id: 'cmt_1', reply_list: { replies: [] } }],
      'cmt_1',
    )
    expect(comment).toEqual({ isWhole: true, quote: '', replies: [] })
  })

  test('a comment with no reply list decodes to an empty reply array', () => {
    const comment = commentFromBatchQuery([{ comment_id: 'cmt_1' }], 'cmt_1')
    expect(comment?.replies).toEqual([])
  })

  test('a reply missing its ids and content decodes to empty fields', () => {
    const comment = commentFromBatchQuery(
      [{ comment_id: 'cmt_1', reply_list: { replies: [{}] } }],
      'cmt_1',
    )
    expect(comment?.replies).toEqual([{ replyId: '', authorId: '', elements: [] }])
  })
})
