# 0010 — Feishu channel: groups are authorized by pairing

- **Status:** Accepted
- **Date:** 2026-05-21
- **Affects:** `plugins/feishu-channel/` (`src/access.ts`, `src/access-store.ts`,
  `src/types.ts`, `src/handlers/im-message.ts`, `skills/access/SKILL.md`)

## Context

A Feishu group was authorized by hand-editing `access.json` — adding an entry
to `groups` keyed by the group's `chat_id`. But an operator has no practical
way to obtain that `chat_id`: it is not surfaced anywhere in the Feishu client.
So the one documented way to bring a group in required a value the operator
could not get.

Direct messages already solved the symmetric problem with **pairing**. Under
the default `pairing` policy an unknown sender's first direct message is held;
the channel answers with a one-time code and records a `pending` entry; the
operator approves the code through the `access` skill and never needs an id.
Groups had no equivalent.

## Decision

A group that is not in `access.groups` is brought in by pairing, reusing the
direct-message machinery — the same `pending` map, the same `generatePairingCode`,
the same `PAIRING_TTL_MS` expiry, the same access-skill "approve a code"
gesture.

- **Trigger — an @-mention, not any message.** A pairing starts only when the
  bot is @-mentioned in an unconfigured group. A non-mention message there is
  dropped silently, as before. An @-mention is a deliberate "engage the bot"
  act — the group equivalent of choosing to open a 1:1 chat. Triggering on any
  message would make the bot post a code in every group it was incidentally
  added to, and would need separate per-message rate-limiting; the mention
  requirement gives both at once.
- **The code is posted into the group.** The channel has the group's `chat_id`
  from the inbound event but no notion of "who the operator is", so it cannot
  direct-message them. The code is visible to all members; it grants nothing on
  its own.
- **One pairing per group at a time.** While a `group` `pending` entry for a
  `chat_id` exists, further mentions are dropped silently rather than posting a
  second code. The entry expires through `pruneExpiredPending`, so an
  un-approved pairing reopens on the next mention after its TTL — at most one
  code per group per hour.
- **`PendingEntry` gains a `kind`** of `'dm' | 'group'`. `normalizePending`
  defaults a missing `kind` to `'dm'`, so an `access.json` written before this
  change loads unchanged. `gateDirect`'s pending search is filtered to
  `kind === 'dm'` — a `group` entry also carries a `senderId` (its triggerer),
  and without the filter that triggerer's later direct message would match the
  group entry and be answered with the group's code.
- **An approved group enters `groups` with `requireMention: true,
  allowFrom: []`.** A group is many people; without mention-gating every
  message in it would reach Claude. This matches the existing default in
  `normalizeAccess` and keeps behavior consistent — the bot answers @-mentions
  in the group both before approval (to pair) and after (to serve).
- **`MAX_PENDING` raised from 3 to 10.** Direct and group pairings share the
  one `pending` map; three slots is too tight once the bot is in a few groups.

## Consequences

- An operator authorizes a group without ever seeing or typing a `chat_id` —
  the access model the feature set out to fix.
- Mention detection needs the bot's own `open_id`, resolved at startup and able
  to fail (the existing degradation behind decision 0008's connection work).
  While it is unknown, an unconfigured group cannot be paired through the
  channel; a hand-edited `groups` entry remains the documented fallback.
- Declining a group means letting its `pending` entry expire. If that group is
  active and members keep @-mentioning the bot, the channel re-posts a code
  every TTL window. The way to stop it for good is to remove the bot from the
  group — an operator action outside the plugin. A `blockedGroups` list would
  let the channel be told to ignore a group permanently; deferred.
- The pending entry carries no group name, so the operator approves an opaque
  `oc_...`. Carrying a name would mean a new transport method and a Feishu API
  call per pairing; deferred to keep this change small.
- Group pairing is unconditional — there is no `dmPolicy`-style switch to turn
  it off. The @-mention trigger already bounds it; a `groupPolicy` toggle is a
  possible future addition.

## References

- `plugins/feishu-channel/src/access.ts` — `gateUnconfiguredGroup` and the
  `kind` filter in `gateDirect`.
- `plugins/feishu-channel/src/types.ts`, `src/access-store.ts` — the
  `PendingEntry.kind` field and its normalization.
- `plugins/feishu-channel/skills/access/SKILL.md` — the `kind`-aware approval.
- [components/feishu-channel.md](/.agents/components/feishu-channel.md).
- [0006](/.agents/decisions/0006-feishu-channel-event-registry.md) — the event
  handler the access gate runs inside.
