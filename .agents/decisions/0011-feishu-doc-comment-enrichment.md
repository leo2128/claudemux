# 0011 — Feishu doc-comment handler: SDK-verified decode and best-effort enrichment

- **Status:** Accepted
- **Date:** 2026-05-21
- **Affects:** `plugins/feishu-channel/`

## Context

[Decision 0006](/.agents/decisions/0006-feishu-channel-event-registry.md)
landed the `drive.notice.comment_add_v1` handler with the event treated as
*unverified*: its `event_type` and payload field names were corroborated only
by third-party integrations, so the handler decoded defensively — trying
several guessed key paths per field and never throwing.

A real event then proved the guesses wrong. The `<channel>` block a live
comment produced named no document, no commenter, and no text: every field
the guessed path table reached came back empty. Two facts surfaced on
inspection:

- The Feishu SDK the plugin already depends on — `@larksuiteoapi/node-sdk` —
  ships `normalizeComment`, a decoder for exactly this event, plus the
  `RawCommentEvent` type. That is the authoritative payload reference the
  third-party survey lacked. It shows the real payload nests the file token,
  file type, and commenter under a `notice_meta` object in one of its
  variants — a path the plugin's guessed table never tried.
- The payload carries only the comment's *identifiers*. The comment **text**
  and the document **title** are not in the event at all; they must be
  fetched from Feishu.

## Decision

### The payload is decoded through the SDK, not a hand-rolled path table

`normalizeCommentEvent` delegates to the SDK's `normalizeComment`. The SDK
tolerates both payload variants Feishu sends and is maintained against the
real event, so the decoder cannot drift from a guess. A non-object input, or
a payload the SDK cannot resolve a file token, file type, comment id, and
commenter from, is a dropped and logged event — the same calibrated drop the
SDK itself applies.

Whether an event is a new comment or a thread reply is read from the presence
of a `reply_id`, the discriminator the SDK uses; the handler no longer relies
on a `notice_type` string.

### The handler enriches the event with fetched content

Because the payload has no comment text and no document title, the handler
fetches both before delivery: the comment thread through the drive
file-comment API, the title and URL through the drive metadata API. Two new
`FeishuTransport` methods — `fetchDocComment` and `fetchDocMeta` — own those
calls, so the handler stays unit-testable against the fake transport.

Enrichment is **best-effort**. Each fetch is independent and degrades on its
own: a comment whose text could not be fetched is still delivered, with the
document still identified and a placeholder in place of the text. A
recognizable event is never dropped because enrichment failed. The
file-comment API serves only a subset of document types — for any other type
the fetch is skipped rather than attempted and caught.

## Consequences

- The doc-comment handler now performs network I/O during `handle`. It is the
  first handler to do so; the `EventHandler` contract already allowed it
  (`handle` is async and receives the transport), and the I/O stays behind
  transport methods so the handler is still tested against a fake.
- The bot needs the document-comment and document-metadata **read** scopes.
  Without them, a comment is delivered but its text and title are
  placeholders — a visible, non-fatal degradation rather than a silent one.
- This revises [decision 0006](/.agents/decisions/0006-feishu-channel-event-registry.md)'s
  treatment of the document-comment event as unverified. The event is now
  decoded against the Feishu SDK; 0006's other choices — the event registry,
  chat_id reply routing, graceful shutdown — are unchanged.
- The plugin's declared floor for `@larksuiteoapi/node-sdk` was raised to
  `^1.64.0`, the version that exports `normalizeComment`.
- Regression guard: `test/handlers/doc-comment.test.ts` covers both payload
  variants, the add_comment / add_reply split, and the degraded-enrichment
  paths (comment fetch failed, metadata fetch failed).

## References

- `plugins/feishu-channel/src/handlers/doc-comment.ts` — the handler and
  `normalizeCommentEvent`.
- `plugins/feishu-channel/src/feishu.ts` — `fetchDocComment` / `fetchDocMeta`.
- [decision 0006](/.agents/decisions/0006-feishu-channel-event-registry.md),
  [components/feishu-channel.md](/.agents/components/feishu-channel.md).
