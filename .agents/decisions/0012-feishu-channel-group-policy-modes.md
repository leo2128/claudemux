# 0012 — Feishu channel: group access is a three-mode policy switch

- **Status:** Accepted
- **Date:** 2026-05-21
- **Affects:** `plugins/feishu-channel/` — `src/access.ts`, `src/access-store.ts`,
  `src/types.ts`, `scripts/configure.ts`, `commands/configure.md`,
  `skills/access/SKILL.md`

## Context

[Decision 0010](/.agents/decisions/0010-feishu-channel-group-pairing.md) made
one group behavior the only group behavior: a group is authorized as a unit,
by pairing — an @-mention in an unconfigured group posts a code the operator
approves into `access.groups`. Operating it surfaced that a single fixed
behavior cannot serve every deployment:

- Some operators want the bot to **ignore groups entirely** — it is a personal
  1:1 assistant, and a pairing code posted into a group it was incidentally
  added to is noise.
- Others want the bot usable in **any group, by the people they already
  trust**, with no per-group approval step — they @-mention it wherever a
  conversation needs it, and the per-person allowlist that already gates direct
  messages is the only gate they want.
- The 0010 per-group model still fits operators who want each group vetted
  before the bot answers there.

These are three different policies, not refinements of one. A switch is the
right shape.

## Decision

Group access becomes a `groupPolicy` field in `access.json`, beside `dmPolicy`,
with three modes:

- **`block`** — every group message is dropped; the bot ignores groups.
- **`allowlist`** — decision 0010, unchanged: a group is authorized as a unit
  by pairing. This is the existing `gateGroupAllowlist` / `gateUnconfiguredGroup`
  / `kind: 'group'` machinery, now reached only in this mode.
- **`follow-user`** — no group is authorized. A group message is delivered when
  the bot is @-mentioned **and** the sender's open_id is on the top-level
  `allowFrom` allowlist — the same allowlist that authorizes direct messages. A
  non-mention message, and a mention from a non-allowlisted sender, are
  dropped; no pairing code is posted into a group.

`gate` branches on `groupPolicy`: `block` drops, `follow-user` runs the new
`gateGroupFollowUser`, `allowlist` runs the 0010 path (`gateGroupAllowlist`).

### configure asks for it

`/feishu-channel:configure` — the credential command — gains a question: which
group policy. `scripts/configure.ts` takes it as a third positional argument
and records it in `access.json`, preserving every other access field, so
re-running configure to change the mode does not wipe the allowlist or any
pending pairings.

### Backward compatibility — default `allowlist`

An `access.json` written before this field existed has no `groupPolicy`.
`normalizeAccess` defaults a missing or invalid value to `allowlist` — so an
existing deployment upgrades with **no behavior change**: it keeps the
decision-0010 group pairing it already had, and its `groups` and group-`kind`
pending entries load untouched. `defaultAccess` (a fresh install) uses the same
`allowlist` default; configure then overwrites it with the operator's explicit
choice. `allowlist` is the conservative default — it keeps every group behind
an explicit approval, where `follow-user` would let any allowlisted person
engage the bot in any group and `block` would silently ignore groups.

### A rename to free the type name

The per-group settings interface was named `GroupPolicy`. The mode type now
needs that name, to parallel `DmPolicy`. The interface is renamed `GroupEntry`
— one entry in `Access.groups`. This is a TypeScript identifier, not a JSON
key: there is no on-disk change.

## Consequences

- An operator picks the group behavior that fits their use, at configure time,
  and changes it later by editing `access.json` — the channel re-reads it on
  every message, no restart.
- Decision 0010 is **not superseded**. Its group-pairing design is mode
  `allowlist`, alive and unchanged; none of its code was removed. `follow-user`
  and `block` were added beside it. 0010 remains the reference for how mode
  `allowlist` works.
- `configure` now writes `access.json` as well as `.env`. Its third positional
  argument is required; the command always supplies it, asking the user from a
  fixed set of three.
- Under `follow-user`, the bot answers an @-mention in any group it is a member
  of, from any allowlisted person. Removing the bot from a group is the only
  way to stop it there — this mode has no per-group disable. The @-mention
  requirement and the allowlist bound it: a non-allowlisted member's mention is
  dropped.
- Under `follow-user`, a non-allowlisted person cannot pair from inside a group
  — no code is posted there. They join the allowlist through a direct-message
  pairing or a hand-edit. This is intentional: it keeps pairing codes out of
  group chats.
- Mention detection still needs the bot's own `open_id`, resolved at startup
  and able to fail (decision 0008's connection work). While it is unknown, a
  `follow-user` group and a mention-gated `allowlist` group drop every message.
  Unchanged from 0010.
- Regression guard: `test/access.test.ts` covers all three modes — `block`
  drops; `follow-user` delivers an allowlisted mention and drops a
  non-allowlisted one, a non-mention, and an unknown-bot-id case; `allowlist`
  still pairs. `test/access-store.test.ts` covers the missing-field default and
  that a pre-`groupPolicy` `access.json` loads as `allowlist` with its `groups`
  and group-`kind` pending intact.

## References

- `plugins/feishu-channel/src/access.ts` — `gateGroup`, `gateGroupFollowUser`,
  `gateGroupAllowlist`.
- `plugins/feishu-channel/src/types.ts` — the `GroupPolicy` mode type and the
  `GroupEntry` rename.
- `plugins/feishu-channel/scripts/configure.ts`,
  `plugins/feishu-channel/commands/configure.md` — the configure question.
- [decision 0010](/.agents/decisions/0010-feishu-channel-group-pairing.md) —
  mode `allowlist`'s design.
- [components/feishu-channel.md](/.agents/components/feishu-channel.md).
