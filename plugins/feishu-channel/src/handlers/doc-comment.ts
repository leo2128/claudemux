/**
 * The `drive.notice.comment_add_v1` handler — new comments and replies on
 * Feishu documents.
 *
 * Payload caveat. Feishu's event-list page is JavaScript-rendered and could
 * not be read directly, so this event_type and its field names are *not*
 * verified against Feishu's own reference docs — they are corroborated by
 * two independent third-party integrations. The decode below is therefore
 * deliberately tolerant: it tries several plausible key paths for every
 * field and never throws on a missing or differently-shaped one. Before
 * enabling this event, confirm in the Feishu app console (Events &
 * Callbacks) that `drive.notice.comment_add_v1` is listed and subscribable;
 * if the live payload differs from the shape assumed here, the handler logs
 * an unrecognized-payload note rather than crashing.
 */

import type { ChannelDelivery, EventHandler, HandlerContext } from '../events'
import { asString, isRecord } from '../json'

/** The Feishu event_type this handler subscribes to. */
export const DOC_COMMENT_EVENT_TYPE = 'drive.notice.comment_add_v1'

/** A normalized document-comment event. Every field is best-effort. */
export interface FeishuCommentEvent {
  /** `add_comment` (new comment) or `add_reply` (reply in a thread); `''` if absent. */
  noticeType: string
  /** Token of the document the comment is on. */
  fileToken: string
  /** Document type — `doc` / `docx` / `sheet` / `bitable` / ... */
  fileType: string
  /** Document title, when the payload carried one. */
  title: string
  /** open_id of the commenter, when resolvable. */
  commenterId: string
  /** Comment id. */
  commentId: string
  /** Reply id — present only for an `add_reply`. */
  replyId: string
  /** Best-effort plain text of the comment. */
  text: string
}

/**
 * Build the `drive.notice.comment_add_v1` event handler: decode the comment
 * payload, drop the bot's own comments and unreadable payloads, and map the
 * rest to a channel delivery.
 */
export function createDocCommentHandler(): EventHandler {
  return {
    eventType: DOC_COMMENT_EVENT_TYPE,
    async handle(raw: unknown, ctx: HandlerContext): Promise<ChannelDelivery | null> {
      const event = normalizeCommentEvent(raw)
      if (!event) return null

      // A payload with no recognizable field is a shape mismatch, not a
      // valid comment — drop it, but log so the operator sees the assumed
      // payload shape no longer holds.
      if (!event.fileToken && !event.commentId && !event.text) {
        ctx.logError(
          `${DOC_COMMENT_EVENT_TYPE}: event payload had no recognizable fields — ` +
            'the comment-event shape may differ from this handler’s assumptions',
        )
        return null
      }

      // Skip the bot's own comments so a future comment-reply tool cannot
      // feed the channel its own output. Fail open: an unresolved commenter
      // is delivered rather than dropped.
      if (
        event.commenterId &&
        ctx.transport.botOpenId &&
        event.commenterId === ctx.transport.botOpenId
      ) {
        return null
      }

      return { content: describeComment(event), meta: buildMeta(event) }
    },
  }
}

/**
 * Reshape a raw `drive.notice.comment_add_v1` payload into a
 * `FeishuCommentEvent`. Returns `null` only for a non-object input; any
 * object yields an event whose fields are filled best-effort. Pure: no I/O,
 * never throws. Tolerates either the event body alone or a full
 * `{ event: ... }` envelope.
 */
export function normalizeCommentEvent(raw: unknown): FeishuCommentEvent | null {
  if (!isRecord(raw)) return null
  const event = isRecord(raw.event) ? raw.event : raw

  return {
    noticeType: deepString(event, [['notice_type'], ['comment', 'notice_type']]),
    fileToken: deepString(event, [
      ['file_token'],
      ['token'],
      ['file', 'token'],
      ['file', 'file_token'],
    ]),
    fileType: deepString(event, [['file_type'], ['file', 'type'], ['file', 'file_type']]),
    title: deepString(event, [['title'], ['file_name'], ['file', 'title'], ['file', 'name']]),
    commenterId: deepString(event, [
      ['operator_id', 'open_id'],
      ['operator', 'open_id'],
      ['user_id', 'open_id'],
      ['commenter', 'open_id'],
      ['operator_id'],
      ['user_id'],
    ]),
    commentId: deepString(event, [['comment_id'], ['comment', 'comment_id'], ['comment', 'id']]),
    replyId: deepString(event, [
      ['reply_id'],
      ['comment', 'reply_id'],
      ['reply', 'reply_id'],
      ['reply', 'id'],
    ]),
    text: extractCommentText(event),
  }
}

/** A human-readable summary of the comment, for the `<channel>` block body. */
function describeComment(event: FeishuCommentEvent): string {
  const who = event.commenterId || 'someone'
  const where = event.title ? `“${event.title}”` : `document ${event.fileToken || '(unknown)'}`
  const verb =
    event.noticeType === 'add_reply'
      ? 'replied in a comment thread on'
      : 'commented on'
  const body = event.text || '(no text content)'
  return `Feishu doc comment — ${who} ${verb} ${where}:\n\n${body}`
}

/** Build the `<channel>` tag attributes for a delivered comment. */
function buildMeta(event: FeishuCommentEvent): Record<string, string> {
  // Keys must be alphanumeric-plus-underscore — a hyphen would be dropped.
  // Empty fields are omitted rather than emitted as blank attributes.
  const meta: Record<string, string> = { kind: 'doc_comment' }
  if (event.noticeType) meta.notice_type = event.noticeType
  if (event.fileToken) meta.file_token = event.fileToken
  if (event.fileType) meta.file_type = event.fileType
  if (event.commentId) meta.comment_id = event.commentId
  if (event.replyId) meta.reply_id = event.replyId
  if (event.commenterId) meta.commenter_id = event.commenterId
  return meta
}

/** Walk `path` into `obj`, returning the value found or `undefined`. */
function deepValue(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (!isRecord(cur)) return undefined
    cur = cur[key]
  }
  return cur
}

/** First non-empty string reachable by one of `paths`, or `''`. */
function deepString(obj: Record<string, unknown>, paths: string[][]): string {
  for (const path of paths) {
    const value = deepValue(obj, path)
    if (typeof value === 'string' && value.length > 0) return value
  }
  return ''
}

/**
 * Best-effort plain text of a comment. The text may arrive as a plain string
 * or as Feishu's rich-content `elements[]` array; both are handled, and an
 * unrecognized shape yields `''`.
 */
function extractCommentText(event: Record<string, unknown>): string {
  const plain = deepString(event, [
    ['content'],
    ['text'],
    ['comment', 'content'],
    ['comment', 'text'],
  ])
  if (plain) return plain

  for (const path of [['content', 'elements'], ['comment', 'content', 'elements'], ['elements']]) {
    const elements = deepValue(event, path)
    if (Array.isArray(elements)) {
      const rendered = elements.map(renderElement).join('').trim()
      if (rendered) return rendered
    }
  }
  return ''
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
