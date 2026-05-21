# 0012 — Feishu channel: focusing doc-comment negotiation on a subscribed document

> **Status: proposed — not implemented.** This record is a design put up for
> negotiation. It describes only the *channel-side* mechanism. The change to
> flow's development workflow that motivates it (moving negotiation onto
> document comments) is the operator's own decision and is out of scope here.
> The open questions near the end must be settled before any of this is built.

- **Status:** Proposed
- **Date:** 2026-05-21
- **Affects:** `plugins/feishu-channel/`

## Context

A planned change to flow's development workflow moves negotiation onto Feishu
document comments: a task produces its first document, and the operator then
negotiates with Claude by commenting on that document rather than in chat or in
a plan review. For that to work, the Feishu channel must let a session **focus
on one document** — comments on the focused document reach the session's
context, comments on every other document are filtered out. This is the
document-comment analogue of the access gating that already decides which
direct senders and which groups may reach a session.

After [decision 0011](/.agents/decisions/0011-feishu-doc-comment-enrichment.md),
a `drive.notice.comment_add_v1` event is decoded and enriched correctly — but
*every* comment the bot can see is delivered. With the workflow above, a
session would be flooded with comments from unrelated documents. The channel
needs a focus gate.

Three facts about how the channel actually runs shape every option below, so
they come first.

### One Feishu connection means one receiving session

The channel's single-instance lock elects exactly one MCP-server process per
machine to hold the inbound Feishu WebSocket; every other session's channel
server stands by. Feishu delivers each event to one connection, so the holder
process receives **every** inbound event for the app. That holder process is
connected over stdio to exactly one Claude Code session, and a
`notifications/claude/channel` notification can only travel down that one
stdio pipe. The holder cannot deliver an event to any other session.

The consequence is unavoidable with one Feishu app: **every document-comment
event reaches exactly one Claude session — the connection holder.** A focus
subscription can decide *whether* the holder session delivers a given
document's comments. It cannot route a document's comments to some *other*
session. Any design that appears to "subscribe a document into session B"
while session A holds the connection is an illusion; the comment physically
arrives at A.

### The channel server cannot learn its Claude session's identity

Claude Code injects no session identifier into a plugin's MCP server. The only
documented environment variable a stdio MCP server receives is
`CLAUDE_PROJECT_DIR`; the MCP `initialize` handshake carries no session id
either. (Hooks do receive a `session_id`, but a hook is not an MCP server.)

What a channel server *does* have is its own process: one MCP-server process
serves one Claude session for that session's lifetime. The server's PID is
therefore a usable stand-in for "which session" — not a Claude-assigned
session id, but a stable per-process identity that is one-to-one with a
session while the server runs. The single-instance lock already relies on
exactly this: it is a pidfile.

### Document-comment events are an app-level subscription

`drive.notice.comment_add_v1` is subscribed once, at the app level — unlike
the `drive.file.*` events, which require a per-document `subscribe` API call.
So the channel receives comments for every document the bot can see, and the
focus filter is necessarily **channel-side**: there is no Feishu-side knob
that says "only push comments for document X". (This should be reconfirmed in
the app console — see the open questions.)

## Proposed design

The shape mirrors the existing access gate: a persisted policy file, a pure
gate function, and a thin interface for changing the policy.

### A focus registry, persisted like access.json

A new state file — `~/.claude/channels/feishu/subscriptions.json`, a sibling
of `access.json` — records the documents currently in focus. It is built and
read with the same discipline as `access.json`: a named path builder in
`src/paths.ts`, atomic writes (temp file + rename, owner-only mode), and
corrupt-file recovery (move aside, fall back to an empty registry). Each entry
records the document and **who focused it**:

- `file_token`, `file_type` — the document.
- `owner_pid` — the PID of the channel-server process whose session ran the
  subscribe. This is the ownership tag the cross-talk guard below depends on.
- `subscribed_at` — for diagnostics and for pruning order.
- an optional human label, so an operator inspecting the file can tell the
  documents apart.

The registry is a small **set**, not a single slot: one task may legitimately
work across two or three documents at once, and a single-slot focus would make
those documents evict each other. Switching focus is unsubscribe-then-subscribe;
there is no implicit auto-subscribe (Claude creates throwaway scratch documents,
and auto-subscribing them would be a footgun).

### The interface is an MCP tool the session calls

The channel exposes new MCP tools — `subscribe_doc(file_token, file_type)`,
`unsubscribe_doc(file_token)`, and a `list_focused_docs` for inspection. When
a task produces its first document, Claude calls `subscribe_doc` with the
token it already holds from creating that document. The tool writes an entry
into the registry tagged with its own server process's PID as `owner_pid`.

An MCP tool is the interface and the registry file is the store, the same
split `access.json` uses: the tool is how a session registers intent, the
file is the cross-process record the holder process reads. Both are needed —
a tool alone could not be read by a different process, and a file alone gives
the session no way to act.

### The gate, and the no-cross-talk guarantee

A new pure function — call it `gateComment` — decides each comment, alongside
the existing `gate` for messages. Given the comment's `file_token` and the
registry, under the focused policy it delivers the comment only when the
registry holds a matching entry **whose `owner_pid` equals the holder
process's own PID** (and whose process is still alive). Every other comment is
dropped, with a logged reason, exactly as a gated-out message is.

The `owner_pid` check is the cross-talk guard. Consider a non-holder session
that calls `subscribe_doc`: its entry is written with *its* PID, not the
holder's. The holder's `gateComment` sees `owner_pid != self`, and drops that
document's comments instead of delivering them into the holder session's
context. Without the check, a focus registered by one session would silently
pull a different session's negotiation into the holder — the document-comment
version of the bug the single-instance lock was built to stop.

Because the holder only honors focus entries it owns, the feature is, by
construction, **single-session**: doc-comment negotiation works in whichever
session holds the inbound connection. To keep that honest at the point of use,
`subscribe_doc` checks the instance lock and, when the calling session is not
the holder, says so in its result — "registered, but this session does not
hold the Feishu inbound connection, so these comments will not reach it." No
silently dead subscriptions.

Stale entries are pruned the way expired pairing requests and stale lockfiles
already are: on load, an entry whose `owner_pid` is no longer a live process
is dropped, so a crashed task's focus does not linger.

### The all-vs-focused switch

Whether the focused gate is active at all is a policy, parallel to
`access.json`'s `dmPolicy`: `all` delivers every recognized comment (the
post-0011 behavior), `focused` delivers only owned, in-focus documents,
`disabled` delivers none. Placing the switch and the registry is one of the
open questions below.

## Open questions to settle before building

These need a direction from the operator; they are not yet decided.

- **The single-session limitation is the crux.** As designed, doc-comment
  negotiation works only in the connection-holder session. If flow tasks run as
  separate claudemux teammate sessions, a teammate is almost never the holder,
  so its `subscribe_doc` would be inert. Is it acceptable that the flow task
  and the Feishu channel must be the *same* session — i.e. the channel runs in
  the session doing the flow work? If genuine per-session routing is required
  instead, that needs one of the heavier options under "What this does not do".

- **Default policy.** Should a fresh install default to `all` (unchanged
  behavior, the channel keeps working as a general doc-comment channel) or to
  `focused` (the flow workflow's intent, but a channel with nothing subscribed
  then delivers no comments at all)? The flow workflow wants `focused`; a
  general install probably wants `all`.

- **Where the policy switch lives.** `access.json` is operator-managed (via
  the `access` skill) and durable; the focus registry is session-managed,
  PID-tagged, and churns as tasks come and go. Mixing the two risks ephemeral
  state in the operator's access file. The proposal leans toward the registry
  as its own file and the `all`/`focused`/`disabled` switch in `access.json`
  (it is an operator decision, like `dmPolicy`) — but this should be confirmed.

- **Confirm the subscription granularity.** The design assumes
  `drive.notice.comment_add_v1` is an app-level subscription. This should be
  reconfirmed in the Feishu app console. If a document-level `subscribe` call
  turns out to be required, `subscribe_doc` would also make that call (and
  `unsubscribe_doc` the matching unsubscribe).

- **PID as identity has edges.** A PID is process-scoped, not session-scoped.
  If Claude Code restarts a session's MCP server, the new process has a new
  PID and the old focus entries orphan — the session would need to
  re-subscribe. This is tolerable (and the stale-pruning cleans it up), but it
  should be a conscious choice, not a surprise.

- **Operator visibility.** Should the `access` skill (or a new skill) be able
  to show and clear the focus registry, the way it manages the allowlist and
  group policy?

## What this does not do

This design does not route one document's comments to one session and another
document's to another. With a single Feishu app and a single inbound
connection that is not possible; the focus registry only filters what the one
holder session receives. Genuine per-session routing would require either a
separate Feishu app per session — each with its own credentials and its own
connection, at a real cost in operator setup — or a relay in which the holder
process forwards events to other sessions' channel servers over a local IPC,
which is substantial new machinery. Both are deliberately out of scope; they
are the path to revisit only if per-session routing becomes a hard
requirement.

## References

- [decision 0011](/.agents/decisions/0011-feishu-doc-comment-enrichment.md) —
  the doc-comment decode and enrichment this gate would sit on top of.
- [decision 0010](/.agents/decisions/0010-feishu-channel-group-pairing.md),
  [decision 0006](/.agents/decisions/0006-feishu-channel-event-registry.md) —
  the access-gating and event-registry patterns this design mirrors.
- `plugins/feishu-channel/src/access.ts`, `src/access-store.ts`,
  `src/instance-lock.ts`, `src/paths.ts` — the existing gate, persisted-policy,
  single-instance, and path-builder code the design reuses.
