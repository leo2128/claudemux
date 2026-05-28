# `tm states` LAST column audit

Date: 2026-05-25
Scope: `plugins/claudemux/src/verbs/states.ts`, Claude engine listing
extras, Codex rollout-backed listing extras.
Status: audited and implemented option B in this branch.

## Shared renderer

`tm states` is engine-agnostic at the verb layer. It calls every registered
engine's `list(ctx.engineContext)` and renders five columns from each
`TeammateListing.extras` map:

- `plugins/claudemux/src/verbs/states.ts:35` to
  `plugins/claudemux/src/verbs/states.ts:37` collect all engine listings.
- `plugins/claudemux/src/verbs/states.ts:41` to
  `plugins/claudemux/src/verbs/states.ts:49` render `REPO SID BUSY LAST
  PREVIEW`, with `LAST` coming from `extras['last']`.

That means the LAST column's cross-engine semantics are owned by each engine's
listing extras, not by `statesVerb`.

## Claude current definition

Claude LAST means "byte size and age of the current session's non-empty
`/tmp/claude-idle/<sid>.last` file."

Construction path:

- `plugins/claudemux/src/engines/claude/claude-engine.ts:210` to
  `plugins/claudemux/src/engines/claude/claude-engine.ts:220` samples one
  `now` value per `ClaudeEngine.list()` call.
- `plugins/claudemux/src/engines/claude/claude-engine.ts:231` to
  `plugins/claudemux/src/engines/claude/claude-engine.ts:243` delegates to
  `listingExtras(name, now)` and copies `extras.last` into the row.
- `plugins/claudemux/src/engines/claude/state.ts:103` to
  `plugins/claudemux/src/engines/claude/state.ts:120` reads the teammate's
  sid, stats `<sid>.last`, renders `${stat.size}B/${fmtAge(now - mtime)}`, and
  derives PREVIEW from the same file.
- The hook writer is `plugins/claudemux/hooks/on-stop.sh:233` to
  `plugins/claudemux/hooks/on-stop.sh:247`: on `Stop`, after the transcript
  looks settled, it extracts the assistant text and writes `$last_file`.

The important invariant is that Claude LAST size, LAST age, and PREVIEW are all
derived from the same artifact: the `.last` file that `tm last` also reads.

## Codex current definition

Codex LAST means "byte size and age of the current thread's latest
assistant-visible text in the rollout JSONL."

Construction path after this branch:

- `plugins/claudemux/src/engines/codex/engine.ts:716` to
  `plugins/claudemux/src/engines/codex/engine.ts:725` reads the current
  daemon thread id and its rollout snapshot.
- `plugins/claudemux/src/engines/codex/rollout.ts:214` to
  `plugins/claudemux/src/engines/codex/rollout.ts:237` accepts
  assistant-visible rollout entries: snake `agent_message`, camel
  `agentMessage`, assistant `message` response items, and nested
  `payload.item.agentMessage`, limited to `final_answer` or `commentary`.
- `plugins/claudemux/src/engines/codex/rollout.ts:240` to
  `plugins/claudemux/src/engines/codex/rollout.ts:245` parses the matching
  entry's `timestamp`.
- `plugins/claudemux/src/engines/codex/rollout.ts:315` to
  `plugins/claudemux/src/engines/codex/rollout.ts:334` keeps the latest
  matching assistant text plus that exact entry timestamp.
- `plugins/claudemux/src/engines/codex/engine.ts:368` to
  `plugins/claudemux/src/engines/codex/engine.ts:377` renders LAST from
  the text byte length and the assistant timestamp age, falling back to rollout
  file mtime only when the assistant entry has no parseable timestamp.
- `plugins/claudemux/src/engines/codex/engine.ts:381` to
  `plugins/claudemux/src/engines/codex/engine.ts:400` places those cells
  into `extras.last` and `extras.preview`.

Before this branch, the Codex LAST size and PREVIEW were already based on the
latest assistant text, but the LAST age used the whole rollout file's mtime.

## Difference and user impact

The meaningful difference was the time source:

- Claude used the mtime of the exact `.last` artifact whose bytes and preview
  it displayed.
- Codex used the bytes and preview of the latest assistant text, but used the
  rollout file mtime. A later non-assistant append, for example token usage or
  activity metadata, could make LAST read as fresh while PREVIEW still showed an
  older assistant answer.

That made mixed-engine `tm states` rows easy to misread. A user scanning LAST
could interpret `20B/5s` on Codex as "Codex last answered 5 seconds ago" when
the assistant answer was older and only the rollout file had been touched.

## Candidate options

Option A: keep status quo and document that Codex LAST age is rollout-file
freshness.

- Pros: no behavior change; Codex activity and rollout persistence stay coupled.
- Cons: LAST and PREVIEW can describe different events; mixed Claude/Codex rows
  remain confusing.

Option B: define LAST as "latest assistant-visible text size plus text age" for
both engines.

- Pros: LAST and PREVIEW refer to the same reply on both engines; Claude's
  existing `.last` behavior already satisfies this; Codex can derive the same
  meaning from rollout entry timestamps and keep file-mtime fallback for older
  or partial rollouts.
- Cons: Codex LAST no longer doubles as a generic rollout activity clock.
  Generic activity remains available through `tm status` diagnostics and Codex
  busy-state fallback.

Option C: redefine LAST as "last engine activity" for both engines.

- Pros: optimizes for liveness scanning and would align with Codex's previous
  rollout-mtime behavior.
- Cons: breaks the visible "LAST/PREVIEW" pairing; Claude would need a new
  activity marker distinct from `.last`; `tm last` and `tm states` would no
  longer be conceptually adjacent.

## Recommendation

Choose option B. The table already labels the adjacent column PREVIEW, and the
help text describes LAST as "size + age of the last assistant reply"
(`plugins/claudemux/src/help.ts:65` to
`plugins/claudemux/src/help.ts:71`). Keeping LAST tied to the same
assistant-visible text gives users one cross-engine mental model:

`LAST = bytes and age of the reply shown in PREVIEW; "-" means no current-thread
reply text is available.`

This branch implements that recommendation for Codex by carrying
`lastAssistantAtMs` in `CodexRolloutSnapshot` and using it for `tm states` LAST
age, with rollout mtime as compatibility fallback when the timestamp is absent
or unparseable.

## Hazard dispositions

Recorded on 2026-05-25 after implementing option B.

| Hazard | Disposition |
|---|---|
| Codex assistant entry has no parseable `timestamp` | Accepted with fallback: `tm states` uses the rollout file mtime only when the matching assistant entry lacks a parseable timestamp. That preserves older or partial rollout compatibility without making timestamp-less rows disappear. |
| Rollout file is missing for the current Codex thread | Already handled by the existing snapshot boundary: `readCodexRolloutSnapshot()` returns `null`, and `codexListExtras()` renders `LAST` and `PREVIEW` as `-`. No new failure mode was introduced. |
| Large rollout scan adds cost to `tm states` | No additional scan was added. The existing `readCodexRolloutSnapshot()` pass already walks the JSONL once to find assistant text and token usage; the implementation captures the timestamp during that same pass. |
| Multi-client or append-in-progress rollout writes produce a partial line | Already handled by the existing parser behavior: blank lines and JSON parse failures are skipped, so a partially written trailing record does not replace the last valid assistant text. The previous valid assistant timestamp remains the source for LAST age. |
| Activity freshness is still needed somewhere | Preserved separately. Codex list/status still use rollout mtime and daemon `last-seen` for activity and busy-state diagnostics; only the visible `LAST` cell was narrowed to the reply shown in `PREVIEW`. |
