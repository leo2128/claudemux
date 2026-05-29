# Feishu channel: a received-reaction indicator on inbound chat messages

- **Status:** Accepted
- **Date:** 2026-05-21
- **Affects:** `plugins/feishu-channel/`

## Context

A Feishu sender messages the bot and then waits. Nothing on the Feishu side
tells them their message was received: an approved message is delivered into
the Claude session as a `<channel>` notification, but the first visible
acknowledgement is Claude's eventual `reply` — which can be slow, and never
arrives at all if the session is busy elsewhere. The sender cannot distinguish
"received, being worked on" from "lost".

Feishu messages support emoji **reactions** through the `im` message-reaction
API: `create` adds one and returns a `reaction_id`, `delete` removes it by that
id. A reaction the bot places on the sender's own message is a low-noise way to
signal state back to them, in their conversation, without sending a message.

## Decision

The channel places a "received" reaction on an inbound chat message once it
reaches the session, and removes it once Claude answers.

### Timing — after the notification is dispatched

The reaction is added in `handleEvent`, immediately after `deps.notify(...)`
returns successfully. That is the precise moment the message has cleared the
access gate and been pushed into the session's context. Reacting earlier — on
receipt, before the gate — would acknowledge messages the channel then drops
(unpaired senders, gated-out groups), telling a sender their message landed
when it did not.

### Emoji — a random pick from a "seen, on it" pool

One emoji is chosen at random per message from a fixed pool so the
acknowledgement feels alive rather than canned. Every option reads as "seen,
being worked on", which is the signal the sender wants: `GLANCE` (👀 看),
`LGTM` (了解), `Typing` (敲键盘), `GoGoGo` (冲), `OnIt` (在做了). The pool is
`RECEIVED_REACTION_EMOJIS` in `src/server.ts`; `pickReceivedReactionEmoji()`
selects one. Removal is keyed by the returned `reaction_id`, so clearing works
regardless of which emoji was placed.

### The message_id → reaction_id map is in-memory

`delete` needs the `reaction_id` that `create` returned, so the channel must
remember it. The map (`message_id → { chatId, reactionId }`) lives in memory in
the `createChannelCore` closure, not on disk:

- The process holding the inbound connection is the same process whose `reply`
  tool answers the session it feeds. Inbound events and the replies that clear
  them run in one process, so a process-local map is consistent. (A standby
  instance that holds no inbound connection never receives the events and never
  populates a map.)
- A persisted map would be shared across every channel process via the file,
  but a reaction's lifecycle belongs to exactly the one process that added it —
  Feishu only lets the adding app remove a reaction.
- A server restart discards the Claude conversation and the map together.
  Persisting the map would only preserve indicators for context that no longer
  exists; the dangling reactions a crash leaves behind are a cosmetic loose end
  on a now-stale message, not a correctness problem.

### A reply clears every pending message in the chat

`reply` carries only a `chat_id`; a reaction lives on a specific `message_id`.
When Claude replies into a chat, the channel removes the indicator from *every*
message in that chat still awaiting a reply — not just the most recent. The
indicator means "received, not yet answered"; once Claude answers the chat,
everything outstanding in it is treated as addressed by that answer. Clearing
only the latest would strand an "eyes" reaction on earlier messages a single
reply already covered.

### Scope — IM messages only

The reaction applies to `kind="message"` deliveries. A document comment
(`kind="doc_comment"`) is not an IM message and the message-reaction API has
nothing to act on for it, so `markReceived` returns early for it.

### Best-effort throughout

A failed reaction add or remove is logged and the channel moves on — it never
fails delivery or a reply. A message whose removal failed is still dropped from
the map, so a `reaction_id` Feishu will not accept is not retried on every
later reply.

## Consequences

- The bot needs the message-reaction scope for both adding and removing
  reactions. It already needed the add scope for the `react` tool; the
  README's scope step now names removal too.
- The `FeishuTransport.addReaction` contract changed: it returns the
  `reaction_id` (`Promise<string>`) instead of `Promise<void>`, and a new
  `removeReaction(messageId, reactionId)` was added. The `react` MCP tool keeps
  using `addReaction` and simply ignores the returned id.
- The indicator and the `react` tool share the same transport methods, but
  only the indicator's reactions are tracked in the map — a `react` call is
  Claude placing an arbitrary emoji and is not part of this lifecycle.
- A crash or instance takeover can leave a `GLANCE` reaction on an old message
  with no map entry to remove it. This is accepted: the message's Claude
  conversation is gone too.
- Regression guard: `test/server.test.ts` and `test/integration.test.ts` cover
  add-on-delivery, clear-on-reply, the multi-message and multi-chat cases, the
  gated-out and doc-comment no-reaction cases, and the add/remove/send failure
  paths.

## References

- `plugins/feishu-channel/src/server.ts` — `markReceived`, `clearReceived`,
  `RECEIVED_REACTION_EMOJI`, the `pendingReactions` map.
- `plugins/feishu-channel/src/feishu.ts` — `addReaction` / `removeReaction`.
- [decision feishu-channel-event-registry](/.agents/decisions/feishu-channel-event-registry.md) —
  the event registry and chat_id reply routing this builds on.
- [components/feishu-channel.md](/.agents/components/feishu-channel.md).
