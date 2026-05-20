---
name: access
description: Manage who may reach a Claude Code session through the Feishu channel — approve a first-time direct-message sender's pairing code, manage the direct-message allowlist, and configure which Feishu groups the bot answers in. Use when the user wants to approve, pair, allowlist, or block a Feishu sender, received a pairing code, or asks why a Feishu message was not delivered. Also use for the Chinese phrasings — "飞书配对 / 通过配对码 / 飞书 allowlist / 批准飞书用户 / 飞书群授权".
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
- `pending` — pairing requests awaiting approval, keyed by pairing code.

The channel writes this file atomically and re-reads it on every inbound
message, so an edit takes effect on the next message — no restart needed.
Always read the current file before editing and write valid JSON back; a
corrupt file makes the channel fall back to safe defaults (pairing required,
nothing allowed) rather than failing open.

## Approve a first-time direct-message sender

Under the default `pairing` policy, an unknown sender's first direct message
is not delivered — the channel replies to them with a one-time **pairing
code** and records a `pending` entry. To approve that sender:

1. Read `access.json`.
2. Find the `pending` entry whose key matches the code the human relays from
   the sender. Read its `senderId` (the sender's open_id).
3. Add that `senderId` to the top-level `allowFrom` array.
4. Remove the now-used entry from `pending`.
5. Write the file back as valid JSON.

The sender's next message is then delivered. If the human cannot produce a
code, do not guess one — ask them to have the sender message the bot again to
receive a fresh code.

## Other access changes

- **Block a sender** — remove their open_id from `allowFrom`.
- **Skip pairing** — set `dmPolicy` to `allowlist` to deliver only from
  `allowFrom` with no pairing step, or to `disabled` to drop all direct
  messages.
- **Add a group** — add an entry to `groups` keyed by the group's chat_id.
  Keep `requireMention: true` unless the human wants every message in that
  group delivered. Leave that group's `allowFrom` empty to allow any group
  member, or list open_ids to restrict who triggers the bot there.

## Why access is keyed on open_id

Access is gated on the Feishu `open_id` — the stable per-app user identifier
carried in the `sender_id` attribute of every inbound `<channel>` block.
Display names are not unique and can change, so never gate on a name.
