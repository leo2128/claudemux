# 0016 — Feishu doc-comment text is fetched with `batchQuery`, not `get`

- **Status:** Accepted
- **Date:** 2026-05-22
- **Affects:** `plugins/feishu-channel/`

## Context

[Decision 0011](/.agents/decisions/0011-feishu-doc-comment-enrichment.md)
landed doc-comment enrichment: because a `drive.notice.comment_add_v1`
payload carries no comment text, the handler fetches the comment through the
Feishu drive file-comment API. `fetchDocComment` called the SDK's
`client.drive.fileComment.get` — the single-comment endpoint.

A live `add_reply` event then arrived with full routing metadata but an empty
body: the channel filled in its placeholder, `(comment text unavailable — the
channel could not fetch it; read it on the document)`. The comment text
plainly existed — a human had just typed it.

0011's Consequences section attributed exactly this degradation to a missing
scope: *"The bot needs the document-comment and document-metadata read
scopes. Without them, a comment is delivered but its text and title are
placeholders."* That framing points at the Feishu Open Platform console, not
at the code — and it is wrong for this failure.

The channel app's own `tenant_access_token` was used to probe the live API
against the failing comment (`file_token` `BMM2dvPuHoap9kxykSYcJ83Rn5e`,
a `docx`):

- `drive.fileComment.get` — `code 1069307`, `"not exist"`.
- `drive.fileComment.list` — succeeds, returns the comment and its reply text.
- `drive.fileCommentReply.list` — succeeds, returns the reply text.
- `drive.fileComment.batchQuery` — succeeds, returns the comment.
- `drive.meta.batchQuery` — succeeds, returns the document title and URL.

A missing scope would have failed the list, replies, and batch_query calls
too — they share the same permission family. Only `get` failed. Feishu's own
API reference settles why: `fileComment.get` is *获取全文评论* — get a
**whole-document** comment — and explicitly **不支持局部评论** (does not serve
local-selection comments). The failing comment has `is_whole: false`: it is
anchored to a quoted text selection, which is how most document comments are
made. `get` also does not return the `is_whole` / `quote` fields at all, so
the "On the selected text" context line was dead even when `get` did resolve
a whole-document comment.

The cause is the endpoint choice, in the channel's code — not the bot's
permissions.

## Decision

`fetchDocComment` fetches through `client.drive.fileComment.batchQuery`,
passing the single `comment_id` from the event. `batchQuery` resolves a
comment by id and serves both whole-document and local-selection comments,
returning `is_whole`, `quote`, and the reply thread — the full
`FeishuDocComment` shape the handler already consumes.

The response-shaping step is a pure, exported function,
`commentFromBatchQuery(items, commentId)`: it picks the requested comment out
of the `batchQuery` `items` array and maps it to a `FeishuDocComment`, or
returns `null` when the response carried no such comment. `createFeishuTransport`
needs a live Feishu app and stays untested; pulling the decode into a pure
function lets `test/feishu.test.ts` cover it — including the local-selection
case (`is_whole: false` with a `quote`) that exercised the bug — against a
fixture in the real `batchQuery` response shape.

## Consequences

- A local-selection comment — the common case — now delivers its text and its
  quoted anchor instead of the placeholder. The placeholder remains for a
  genuine fetch failure, which is still a non-fatal degradation.
- The `FeishuTransport` interface, `FeishuDocComment`, and the doc-comment
  handler are unchanged: the fix is contained to `fetchDocComment` and the
  decoder it delegates to.
- Known degradation, not fixed here: `batchQuery` pages a comment's
  `reply_list`, so a thread longer than one page returns a partial reply set.
  `pickReply` already degrades to the most recent fetched reply in that case;
  for an `add_reply` whose new reply paged off, the delivered text is a
  best-effort guess. Threads that large are rare enough not to warrant a
  second paged call on every event.
- 0011's enrichment design stands; this record corrects only its attribution
  of the empty-body symptom to a missing scope. The bot does need a
  comment-read scope to fetch at all — but when a comment is delivered with an
  empty body, the endpoint, not the scope, is the thing to check first.
- Regression guard: `test/feishu.test.ts` covers `commentFromBatchQuery` —
  the local-selection and whole-document cases, comment-not-in-response,
  empty response, and missing-field defaults.

## References

- `plugins/feishu-channel/src/feishu.ts` — `fetchDocComment`,
  `commentFromBatchQuery`.
- `plugins/feishu-channel/test/feishu.test.ts` — the decoder's tests.
- [decision 0011](/.agents/decisions/0011-feishu-doc-comment-enrichment.md),
  [components/feishu-channel.md](/.agents/components/feishu-channel.md).
- Feishu API reference: drive-v1 `file-comment/get` (获取全文评论, 不支持局部评论)
  and `file-comment/batch_query` (批量获取评论).
