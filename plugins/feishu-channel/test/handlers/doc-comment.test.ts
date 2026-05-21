import { describe, expect, test } from 'bun:test'
import fc from 'fast-check'
import type { HandlerContext } from '../../src/events'
import type { FeishuDocComment, FeishuDocMeta } from '../../src/feishu'
import {
  DOC_COMMENT_EVENT_TYPE,
  createDocCommentHandler,
  normalizeCommentEvent,
} from '../../src/handlers/doc-comment'
import { FakeTransport } from '../support/fake-transport'

/**
 * A plausible `drive.notice.comment_add_v1` event body in the flat variant —
 * file token, file type, and commenter at the top level.
 */
function commentEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    file_token: 'doccnAbC123',
    file_type: 'docx',
    comment_id: 'cmt_1',
    user_id: { open_id: 'ou_commenter' },
    is_mentioned: true,
    create_time: '1716200000000',
    ...overrides,
  }
}

/**
 * The same event in the `notice_meta`-nested variant — file token, file type,
 * and commenter under `notice_meta`. Feishu sends both shapes; the SDK decoder
 * the handler delegates to handles each.
 */
function noticeMetaEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    comment_id: 'cmt_1',
    notice_meta: {
      from_user_id: { open_id: 'ou_commenter' },
      file_token: 'doccnAbC123',
      file_type: 'docx',
      notice_type: 'add_comment',
      is_mentioned: false,
      timestamp: '1716200000000',
    },
    ...overrides,
  }
}

/** A fetched comment thread, as the transport would return it. */
function docComment(overrides: Partial<FeishuDocComment> = {}): FeishuDocComment {
  return {
    isWhole: true,
    quote: '',
    replies: [
      {
        replyId: 'rpl_1',
        authorId: 'ou_commenter',
        elements: [{ text_run: { text: 'please take a look' } }],
      },
    ],
    ...overrides,
  }
}

/** Fetched document metadata, as the transport would return it. */
function docMeta(overrides: Partial<FeishuDocMeta> = {}): FeishuDocMeta {
  return { title: 'Design Notes', url: 'https://feishu.cn/docx/doccnAbC123', ...overrides }
}

/** Build a HandlerContext; the comment handler uses transport + the loggers. */
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
  test('decodes the flat payload variant into all fields', () => {
    expect(normalizeCommentEvent(commentEvent())).toEqual({
      fileToken: 'doccnAbC123',
      fileType: 'docx',
      commentId: 'cmt_1',
      replyId: '',
      commenterId: 'ou_commenter',
      mentionedBot: true,
    })
  })

  test('decodes the notice_meta-nested payload variant into all fields', () => {
    expect(normalizeCommentEvent(noticeMetaEvent())).toEqual({
      fileToken: 'doccnAbC123',
      fileType: 'docx',
      commentId: 'cmt_1',
      replyId: '',
      commenterId: 'ou_commenter',
      mentionedBot: false,
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
    const event = normalizeCommentEvent(commentEvent({ reply_id: 'rpl_9' }))
    expect(event?.replyId).toBe('rpl_9')
  })

  test('a new comment has an empty reply id', () => {
    expect(normalizeCommentEvent(commentEvent())?.replyId).toBe('')
  })

  test('returns null when the payload lacks a resolvable file type', () => {
    expect(normalizeCommentEvent(commentEvent({ file_type: undefined }))).toBeNull()
  })

  test('returns null when the payload lacks a resolvable commenter', () => {
    expect(normalizeCommentEvent(commentEvent({ user_id: undefined }))).toBeNull()
  })

  test('returns null for an empty object', () => {
    expect(normalizeCommentEvent({})).toBeNull()
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
  test('delivers an enriched comment with text, title, and routing meta', async () => {
    const transport = new FakeTransport()
    transport.docComment = docComment()
    transport.docMeta = docMeta()
    const delivery = await createDocCommentHandler().handle(commentEvent(), makeCtx(transport))

    expect(delivery?.content).toContain('please take a look')
    expect(delivery?.content).toContain('commented on')
    expect(delivery?.content).toContain('Design Notes')
    expect(delivery?.content).toContain('https://feishu.cn/docx/doccnAbC123')
    expect(delivery?.meta).toEqual({
      kind: 'doc_comment',
      notice_type: 'add_comment',
      file_token: 'doccnAbC123',
      file_type: 'docx',
      comment_id: 'cmt_1',
      commenter_id: 'ou_commenter',
      mentioned_bot: 'true',
      doc_url: 'https://feishu.cn/docx/doccnAbC123',
    })
  })

  test('fetches the comment and the metadata for the event document', async () => {
    const transport = new FakeTransport()
    transport.docComment = docComment()
    transport.docMeta = docMeta()
    await createDocCommentHandler().handle(commentEvent(), makeCtx(transport))

    expect(transport.commentFetches).toEqual([
      { fileToken: 'doccnAbC123', fileType: 'docx', commentId: 'cmt_1' },
    ])
    expect(transport.metaFetches).toEqual([{ fileToken: 'doccnAbC123', fileType: 'docx' }])
  })

  test('an add_reply picks the matching reply and reads as a thread reply', async () => {
    const transport = new FakeTransport()
    transport.docComment = docComment({
      replies: [
        { replyId: 'rpl_1', authorId: 'ou_a', elements: [{ text_run: { text: 'first' } }] },
        { replyId: 'rpl_9', authorId: 'ou_commenter', elements: [{ text_run: { text: 'the reply' } }] },
      ],
    })
    const delivery = await createDocCommentHandler().handle(
      commentEvent({ reply_id: 'rpl_9' }),
      makeCtx(transport),
    )

    expect(delivery?.meta.reply_id).toBe('rpl_9')
    expect(delivery?.meta.notice_type).toBe('add_reply')
    expect(delivery?.content).toContain('replied in a comment thread')
    expect(delivery?.content).toContain('the reply')
    expect(delivery?.content).not.toContain('first')
  })

  test('shows the quoted selection for a local-selection comment', async () => {
    const transport = new FakeTransport()
    transport.docComment = docComment({ isWhole: false, quote: 'the latency paragraph' })
    const delivery = await createDocCommentHandler().handle(commentEvent(), makeCtx(transport))

    expect(delivery?.content).toContain('the latency paragraph')
  })

  test('flattens rich content elements, including person mentions', async () => {
    const transport = new FakeTransport()
    transport.docComment = docComment({
      replies: [
        {
          replyId: 'rpl_1',
          authorId: 'ou_commenter',
          elements: [
            { text_run: { text: 'cc ' } },
            { person: { user_id: 'ou_reviewer' } },
            { text_run: { text: ' please' } },
          ],
        },
      ],
    })
    const delivery = await createDocCommentHandler().handle(commentEvent(), makeCtx(transport))
    expect(delivery?.content).toContain('cc @ou_reviewer please')
  })

  test('every meta key is alphanumeric-plus-underscore', async () => {
    const transport = new FakeTransport()
    transport.docComment = docComment()
    transport.docMeta = docMeta()
    const delivery = await createDocCommentHandler().handle(
      commentEvent({ reply_id: 'rpl_1' }),
      makeCtx(transport),
    )
    for (const key of Object.keys(delivery?.meta ?? {})) {
      expect(key).toMatch(/^[A-Za-z0-9_]+$/)
    }
  })
})

describe('createDocCommentHandler — degraded enrichment', () => {
  test('delivers with a placeholder when the comment text cannot be fetched', async () => {
    const transport = new FakeTransport()
    transport.docMeta = docMeta()
    // docComment left null — the fetch failed.
    const delivery = await createDocCommentHandler().handle(commentEvent(), makeCtx(transport))

    expect(delivery).not.toBeNull()
    expect(delivery?.content).toContain('comment text unavailable')
    // Routing meta is still complete — the document is still identified.
    expect(delivery?.meta.file_token).toBe('doccnAbC123')
    expect(delivery?.meta.comment_id).toBe('cmt_1')
  })

  test('falls back to the file token when the document title cannot be fetched', async () => {
    const transport = new FakeTransport()
    transport.docComment = docComment()
    // docMeta left null — the fetch failed.
    const delivery = await createDocCommentHandler().handle(commentEvent(), makeCtx(transport))

    expect(delivery?.content).toContain('doccnAbC123')
    expect(delivery?.meta.doc_url).toBeUndefined()
  })
})

describe('createDocCommentHandler — drops', () => {
  test('skips the bot’s own comment', async () => {
    const delivery = await createDocCommentHandler().handle(
      commentEvent({ user_id: { open_id: 'ou_bot' } }),
      makeCtx(new FakeTransport('ou_bot')),
    )
    expect(delivery).toBeNull()
  })

  test('an undecodable payload is dropped and logged', async () => {
    const logErrors: string[] = []
    const delivery = await createDocCommentHandler().handle(
      {},
      makeCtx(new FakeTransport(), logErrors),
    )

    expect(delivery).toBeNull()
    expect(logErrors.some((m) => m.includes(DOC_COMMENT_EVENT_TYPE))).toBe(true)
  })

  test('returns null for non-object input', async () => {
    expect(await createDocCommentHandler().handle(null, makeCtx(new FakeTransport()))).toBeNull()
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
