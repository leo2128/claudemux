/**
 * The `drive.notice.comment_add_v1` handler — new comments and replies on
 * Feishu documents.
 *
 * The event payload identifies a comment (file token, comment id, the
 * commenter's open_id) but carries neither the comment text nor the document
 * title. So the handler works in two steps:
 *
 *  1. Decode the payload with the Feishu SDK's own `normalizeComment`. The
 *     SDK is the authoritative decoder for this event — it tolerates both the
 *     flat and the `notice_meta`-nested payload variants Feishu sends, which
 *     a hand-written path table is bound to drift from.
 *  2. Enrich it: fetch the comment's text and the document's title/URL
 *     through the transport, so the delivered `<channel>` block is something
 *     Claude can actually act on. Enrichment is best-effort — a fetch failure
 *     degrades the notification, it never drops a recognizable event.
 *
 * Whether the event is a new comment or a reply is read from the presence of
 * a `reply_id`, which is the discriminator the SDK itself uses.
 */

import * as lark from '@larksuiteoapi/node-sdk'

import type { ChannelDelivery, EventHandler, HandlerContext } from '../events'
import type { FeishuDocComment, FeishuDocCommentReply, FeishuDocMeta } from '../feishu'
import { asString, isRecord } from '../json'

/** The Feishu event_type this handler subscribes to. */
export const DOC_COMMENT_EVENT_TYPE = 'drive.notice.comment_add_v1'

/** A normalized document-comment event — the identifying fields the payload carries. */
export interface FeishuCommentEvent {
  /** Token of the document the comment is on. */
  fileToken: string
  /** Document type — `doc` / `docx` / `sheet` / `bitable` / ... */
  fileType: string
  /** Comment id. */
  commentId: string
  /** Reply id — set only when the event is a reply within a thread, `''` otherwise. */
  replyId: string
  /** open_id of the commenter. */
  commenterId: string
  /** True when the comment @-mentions the bot. */
  mentionedBot: boolean
}

/**
 * Build the `drive.notice.comment_add_v1` event handler: decode the comment
 * payload, drop the bot's own comments and undecodable payloads, fetch the
 * comment text and document title, and map the rest to a channel delivery.
 */
export function createDocCommentHandler(): EventHandler {
  return {
    eventType: DOC_COMMENT_EVENT_TYPE,
    async handle(raw: unknown, ctx: HandlerContext): Promise<ChannelDelivery | null> {
      const event = normalizeCommentEvent(raw)
      if (!event) {
        // The SDK decoder could not resolve a file token, comment id, and
        // commenter — the payload shape no longer matches what the SDK
        // expects. Log it so the operator sees the assumption broke.
        ctx.logError(
          `${DOC_COMMENT_EVENT_TYPE}: could not decode the comment event — ` +
            'the payload carried no resolvable file token, comment id, or commenter',
        )
        return null
      }

      // Skip the bot's own comments so a comment the bot itself posts cannot
      // feed the channel its own output.
      if (ctx.transport.botOpenId && event.commenterId === ctx.transport.botOpenId) {
        ctx.logDebug(`dropped the bot's own comment on ${event.fileToken}`)
        return null
      }

      // The payload has neither the comment text nor the document title.
      // Fetch both — independently, and best-effort: a failure degrades the
      // notification rather than dropping the event.
      const [comment, docMeta] = await Promise.all([
        ctx.transport.fetchDocComment(event.fileToken, event.fileType, event.commentId),
        ctx.transport.fetchDocMeta(event.fileToken, event.fileType),
      ])
      if (!comment) {
        ctx.logDebug(
          `delivering comment ${event.commentId} on ${event.fileToken} without its text — ` +
            'the text could not be fetched',
        )
      }

      return {
        content: describeComment(event, comment, docMeta),
        meta: buildMeta(event, docMeta),
      }
    },
  }
}

/**
 * Reshape a raw `drive.notice.comment_add_v1` payload into a
 * `FeishuCommentEvent`, using the Feishu SDK's `normalizeComment` as the
 * decoder. Returns `null` for a non-object input or a payload the SDK cannot
 * resolve a file token, file type, comment id, and commenter from. Pure: no
 * I/O, never throws. Tolerates either the event body alone (what the SDK's
 * `EventDispatcher` delivers) or a full `{ event: ... }` envelope.
 */
export function normalizeCommentEvent(raw: unknown): FeishuCommentEvent | null {
  if (!isRecord(raw)) return null
  const event = isRecord(raw.event) ? raw.event : raw

  let decoded: lark.CommentEvent | null
  try {
    decoded = lark.normalizeComment(event as lark.RawCommentEvent)
  } catch {
    // `normalizeComment` is pure but not contractually total — guard it so a
    // surprising input shape is a dropped event, not a thrown one.
    return null
  }
  if (!decoded) return null

  return {
    fileToken: decoded.fileToken,
    fileType: decoded.fileType,
    commentId: decoded.commentId,
    replyId: decoded.replyId ?? '',
    commenterId: decoded.operator.openId,
    mentionedBot: decoded.mentionedBot,
  }
}

/** A human-readable summary of the comment, for the `<channel>` block body. */
function describeComment(
  event: FeishuCommentEvent,
  comment: FeishuDocComment | null,
  docMeta: FeishuDocMeta | null,
): string {
  const verb = event.replyId ? 'replied in a comment thread on' : 'commented on'
  const lines = [`Feishu doc comment — ${event.commenterId} ${verb} ${describeDoc(event, docMeta)}:`, '']

  // A local-selection comment is anchored to a quote; show what it points at.
  if (comment && !comment.isWhole && comment.quote) {
    lines.push(`On the selected text: “${comment.quote}”`, '')
  }

  lines.push(commentBody(event, comment))
  return lines.join('\n')
}

/** Name the document a human would recognize: title and link, or the raw token. */
function describeDoc(event: FeishuCommentEvent, docMeta: FeishuDocMeta | null): string {
  if (docMeta?.title && docMeta.url) return `“${docMeta.title}” (${docMeta.url})`
  if (docMeta?.title) return `“${docMeta.title}”`
  return `document ${event.fileToken} (${event.fileType})`
}

/** The text of the comment or reply the event is about, or a clear placeholder. */
function commentBody(event: FeishuCommentEvent, comment: FeishuDocComment | null): string {
  if (!comment) {
    return '(comment text unavailable — the channel could not fetch it; read it on the document)'
  }
  const reply = pickReply(event, comment.replies)
  if (!reply) return '(the comment carried no readable text)'
  const text = renderElements(reply.elements).trim()
  return text || '(the comment carried no readable text)'
}

/**
 * Pick the reply the event is about: the matching reply for an `add_reply`,
 * or the thread's first reply — which is how Feishu models a comment's own
 * text — for a new comment.
 */
function pickReply(
  event: FeishuCommentEvent,
  replies: FeishuDocCommentReply[],
): FeishuDocCommentReply | undefined {
  if (replies.length === 0) return undefined
  if (event.replyId) {
    const exact = replies.find((reply) => reply.replyId === event.replyId)
    if (exact) return exact
    // A long thread can page the new reply off the fetched page; the most
    // recent reply is the best remaining guess.
    return replies[replies.length - 1]
  }
  return replies[0]
}

/** Build the `<channel>` tag attributes for a delivered comment. */
function buildMeta(
  event: FeishuCommentEvent,
  docMeta: FeishuDocMeta | null,
): Record<string, string> {
  // Keys must be alphanumeric-plus-underscore — a hyphen would be dropped.
  // Empty fields are omitted rather than emitted as blank attributes.
  const meta: Record<string, string> = {
    kind: 'doc_comment',
    notice_type: event.replyId ? 'add_reply' : 'add_comment',
    file_token: event.fileToken,
    file_type: event.fileType,
    comment_id: event.commentId,
    commenter_id: event.commenterId,
    mentioned_bot: event.mentionedBot ? 'true' : 'false',
  }
  if (event.replyId) meta.reply_id = event.replyId
  if (docMeta?.url) meta.doc_url = docMeta.url
  return meta
}

/** Render a Feishu rich-content `elements[]` array to plain text. */
function renderElements(elements: unknown[]): string {
  return elements.map(renderElement).join('')
}

/** Render one Feishu rich-content element (`text_run` / `docs_link` / `person`). */
function renderElement(element: unknown): string {
  if (!isRecord(element)) return typeof element === 'string' ? element : ''

  const textRun = isRecord(element.text_run) ? element.text_run : undefined
  if (textRun && typeof textRun.text === 'string') return textRun.text
  if (typeof element.text === 'string') return element.text

  const docsLink = isRecord(element.docs_link) ? element.docs_link : undefined
  if (docsLink && typeof docsLink.url === 'string') return docsLink.url

  const person = isRecord(element.person) ? element.person : undefined
  if (person) {
    const name = asString(person.name) || asString(person.user_id)
    return name ? `@${name}` : '@someone'
  }
  return ''
}
