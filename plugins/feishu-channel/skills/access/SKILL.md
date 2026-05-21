---
name: access
description: Manage who may reach a Claude Code session through the Feishu channel — approve a pairing code from a first-time direct-message sender or an unconfigured group, manage the direct-message allowlist, and configure which Feishu groups the bot answers in. Use when the user wants to approve, pair, allowlist, or block a Feishu sender or group, received a pairing code, or asks why a Feishu message was not delivered. Also use for the Chinese phrasings — "飞书配对 / 通过配对码 / 飞书 allowlist / 批准飞书用户 / 飞书群授权 / 飞书群配对".
---

# Manage Feishu channel access

The Feishu channel gates every inbound message before it reaches Claude, so
an open bot is not an open door to the session. This skill is the operator's
tool for deciding who gets through.

## The policy file

Access state lives in `$HOME/.claude/channels/feishu/access.json`. Its shape:

- `dmPolicy` — `pairing` (default), `allowlist`, or `disabled`.
- `allowFrom` — array of sender open_ids allowed to direct-message the bot.
- `groups` — per-group policy, keyed by the group's chat_id; each entry has
  `requireMention` (boolean) and `allowFrom` (array of open_ids).
- `pending` — pairing requests awaiting approval, keyed by pairing code. Each
  entry has a `kind`: `dm` (a direct sender awaiting the allowlist) or `group`
  (a group awaiting a `groups` entry).

The channel writes this file atomically and re-reads it on every inbound
message, so an edit takes effect on the next message — no restart needed.
Always read the current file before editing and write valid JSON back; a
corrupt file makes the channel fall back to safe defaults (pairing required,
nothing allowed) rather than failing open.

## Approve a pairing code

The channel answers an un-paired contact with a one-time **pairing code** and
records a `pending` entry. This happens for two cases: an unknown sender's
first direct message (under the default `pairing` policy), and the first
@-mention of the bot in a group that is not yet in `groups`. Approving the
code is the same gesture for both — the entry's `kind` says what it grants:

1. Read `access.json`.
2. Find the `pending` entry whose key matches the code the human relays.
3. Apply it according to its `kind`:
   - `kind` is `dm` — add the entry's `senderId` (the sender's open_id) to the
     top-level `allowFrom` array.
   - `kind` is `group` — add the entry's `chatId` (the group's chat_id) to
     `groups` as a new entry: `{ "requireMention": true, "allowFrom": [] }`.
     `requireMention: true` is the safe default for a multi-person chat — the
     bot answers only when @-mentioned — and the human can relax it later. An
     empty `allowFrom` lets any group member trigger the bot.
4. Remove the now-used entry from `pending`.
5. Write the file back as valid JSON.

The next message from that sender — or the next @-mention of the bot in that
group — is then delivered. If the human cannot produce a code, do not guess
one: ask them to have the sender message the bot again, or @-mention the bot
in the group again, to receive a fresh code.

A group pairing code is posted into the group itself, so any member can read
it. That is not a leak: the code alone authorizes nothing — only this approval
step, run by the operator, brings the group in.

## Other access changes

- **Block a sender** — remove their open_id from `allowFrom`.
- **Skip pairing** — set `dmPolicy` to `allowlist` to deliver only from
  `allowFrom` with no pairing step, or to `disabled` to drop all direct
  messages.
- **Add a group** — the normal path is pairing: a member @-mentions the bot in
  the group, the channel posts a code, and the human relays it for the
  approval above. Add a `groups` entry by hand only when the chat_id is
  already known — keep `requireMention: true` unless the human wants every
  message in that group delivered, and leave `allowFrom` empty to allow any
  group member or list open_ids to restrict who triggers the bot there.

## Diagnose a message that did not arrive

When a sender reports a message never reached the session, the channel can
say why. Have the human relaunch Claude Code with `FEISHU_CHANNEL_DEBUG=1`
set in the environment — the channel then logs every gated-out message to
stderr with its reason: `direct messages disabled`, `sender not on
allowlist`, `bot not mentioned`, `unconfigured group; bot not mentioned`, and
so on. Match the reason against the policy above to choose the fix — for
example, `sender not on allowlist` means the sender's open_id must be added to
`allowFrom`. A message from an unconfigured group is not simply lost: an
@-mention of the bot there starts a group pairing, so the fix is to approve
the code the channel posts into that group.

## Why access is keyed on open_id

Access is gated on the Feishu `open_id` — the stable per-app user identifier
carried in the `sender_id` attribute of every inbound `<channel>` block.
Display names are not unique and can change, so never gate on a name.
