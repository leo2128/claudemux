import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import type { HandlerContext } from '../../src/events'
import {
  DOC_COMMENT_EVENT_TYPE,
  createDocCommentHandler,
  normalizeCommentEvent,
} from '../../src/handlers/doc-comment'
import { FakeTransport } from '../support/fake-transport'

/** A plausible `drive.notice.comment_add_v1` event body, with overrides. */
function commentEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    notice_type: 'add_comment',
    file_token: 'doccnAbC123',
    file_type: 'docx',
    title: 'Design Notes',
    operator_id: { open_id: 'ou_commenter' },
    comment_id: 'cmt_1',
    content: { elements: [{ text_run: { text: 'please take a look' } }] },
    ...overrides,
  }
}

/** Build a HandlerContext; the comment handler uses only transport + logError. */
function makeCtx(transport: FakeTransport, logErrors: string[] = []): HandlerContext {
  return {
    transport,
    accessFile: '/unused',
    now: () => 0,
    generateCode: () => 'unused',
    logError: (message) => {
      logErrors.push(message)
    },
    logDebug: () => {},
  }
}

describe('normalizeCommentEvent — extraction', () => {
  test('reshapes a complete comment payload into all fields', () => {
    expect(normalizeCommentEvent(commentEvent())).toEqual({
      noticeType: 'add_comment',
      fileToken: 'doccnAbC123',
      fileType: 'docx',
      title: 'Design Notes',
      commenterId: 'ou_commenter',
      commentId: 'cmt_1',
      replyId: '',
      text: 'please take a look',
    })
  })

  test('unwraps a full {event: ...} envelope', () => {
    const event = normalizeCommentEvent({
      schema: '2.0',
      header: { event_type: DOC_COMMENT_EVENT_TYPE },
      event: commentEvent(),
    })
    expect(event?.fileToken).toBe('doccnAbC123')
    expect(event?.commentId).toBe('cmt_1')
  })

  test('reads a reply id from an add_reply event', () => {
    const event = normalizeCommentEvent(
      commentEvent({ notice_type: 'add_reply', reply_id: 'rpl_9' }),
    )
    expect(event?.noticeType).toBe('add_reply')
    expect(event?.replyId).toBe('rpl_9')
  })

  test('reads plain-string comment content', () => {
    const event = normalizeCommentEvent(commentEvent({ content: 'a plain string comment' }))
    expect(event?.text).toBe('a plain string comment')
  })

  test('flattens rich content elements, including person mentions', () => {
    const event = normalizeCommentEvent(
      commentEvent({
        content: {
          elements: [
            { text_run: { text: 'cc ' } },
            { person: { name: 'Reviewer' } },
            { text_run: { text: ' please' } },
          ],
        },
      }),
    )
    expect(event?.text).toBe('cc @Reviewer please')
  })

  test('missing fields become empty strings, not undefined', () => {
    const event = normalizeCommentEvent({})
    expect(event).toEqual({
      noticeType: '',
      fileToken: '',
      fileType: '',
      title: '',
      commenterId: '',
      commentId: '',
      replyId: '',
      text: '',
    })
  })

  test('resolves a commenter id from a flat operator_id string', () => {
    const event = normalizeCommentEvent(commentEvent({ operator_id: 'ou_flat' }))
    expect(event?.commenterId).toBe('ou_flat')
  })

  test('returns null for non-object input', () => {
    expect(normalizeCommentEvent(null)).toBeNull()
    expect(normalizeCommentEvent('a string')).toBeNull()
    expect(normalizeCommentEvent(42)).toBeNull()
  })
})

describe('createDocCommentHandler — identity', () => {
  test('subscribes to drive.notice.comment_add_v1', () => {
    expect(createDocCommentHandler().eventType).toBe(DOC_COMMENT_EVENT_TYPE)
  })
})

describe('createDocCommentHandler — delivery', () => {
  test('delivers a comment with routing meta', async () => {
    const handler = createDocCommentHandler()
    const delivery = await handler.handle(commentEvent(), makeCtx(new FakeTransport()))

    expect(delivery?.content).toContain('please take a look')
    expect(delivery?.content).toContain('commented on')
    expect(delivery?.meta).toEqual({
      kind: 'doc_comment',
      notice_type: 'add_comment',
      file_token: 'doccnAbC123',
      file_type: 'docx',
      comment_id: 'cmt_1',
      commenter_id: 'ou_commenter',
    })
  })

  test('an add_reply carries reply_id and reads as a thread reply', async () => {
    const handler = createDocCommentHandler()
    const delivery = await handler.handle(
      commentEvent({ notice_type: 'add_reply', reply_id: 'rpl_9' }),
      makeCtx(new FakeTransport()),
    )

    expect(delivery?.meta.reply_id).toBe('rpl_9')
    expect(delivery?.content).toContain('replied in a comment thread')
  })

  test('every meta key is alphanumeric-plus-underscore', async () => {
    const handler = createDocCommentHandler()
    const delivery = await handler.handle(
      commentEvent({ notice_type: 'add_reply', reply_id: 'rpl_9' }),
      makeCtx(new FakeTransport()),
    )

    for (const key of Object.keys(delivery?.meta ?? {})) {
      expect(key).toMatch(/^[A-Za-z0-9_]+$/)
    }
  })
})

describe('createDocCommentHandler — drops', () => {
  test('skips the bot’s own comment', async () => {
    const handler = createDocCommentHandler()
    const delivery = await handler.handle(
      commentEvent({ operator_id: { open_id: 'ou_bot' } }),
      makeCtx(new FakeTransport('ou_bot')),
    )
    expect(delivery).toBeNull()
  })

  test('an unrecognizable payload is dropped and logged', async () => {
    const handler = createDocCommentHandler()
    const logErrors: string[] = []
    const delivery = await handler.handle({}, makeCtx(new FakeTransport(), logErrors))

    expect(delivery).toBeNull()
    expect(logErrors.some((m) => m.includes(DOC_COMMENT_EVENT_TYPE))).toBe(true)
  })

  test('returns null for non-object input', async () => {
    const handler = createDocCommentHandler()
    expect(await handler.handle(null, makeCtx(new FakeTransport()))).toBeNull()
  })
})

describe('createDocCommentHandler — resilience', () => {
  test('normalizeCommentEvent never throws for arbitrary input', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        normalizeCommentEvent(raw)
      }),
    )
  })

  test('handle never rejects for arbitrary input', async () => {
    const handler = createDocCommentHandler()
    const ctx = makeCtx(new FakeTransport('ou_bot'))
    await fc.assert(
      fc.asyncProperty(fc.anything(), async (raw) => {
        await handler.handle(raw, ctx)
      }),
    )
  })
})
