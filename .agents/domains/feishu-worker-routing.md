# Domain: Feishu Worker-scoped subscription routing

> **Status:** Design spec — converged 2026-05-22 across a four-round design
> debate and one independent architecture review, **not yet implemented**. The
> contract below is what an implementation must satisfy. The settled
> trade-offs and the two residual rulings are recorded in
> [decision 0016](/.agents/decisions/0016-feishu-worker-scoped-subscription.md).

This document specifies how a Feishu event reaches **only** the one Claude Code
Worker that subscribed to its resource — a document's comments to the Worker
that wrote that document, a group's messages to the Worker that owns that
group — when Feishu itself delivers every event app-wide with no per-resource
isolation.

If your task reads or writes any file under `~/.claude/channels/feishu/routes/`
or `~/.claude/channels/feishu/inbox/`, or touches the holder/endpoint split,
read this whole document first.

## 1. The problem

Feishu event subscription is **app-level**: one app, one event stream, events
typed by `event_type`, not scoped to a resource. Opening several long
connections on one app does not split events by resource — Feishu's cluster
mode hands each event to a random one of the connections. There is no
connection↔resource binding and no per-chat subscription dimension. So any
"each Worker hears only its own scope" behavior must be built in user space.

claudemux runs many Workers concurrently (one Claude Code session per repo).
Each Worker that writes a Feishu doc should receive that doc's comments — and
nothing else — pushed into its own session context, with the dispatcher **not**
on the data path.

## 2. Topology

- **One Feishu self-built app.** Its state directory `~/.claude/channels/feishu/`
  is a machine-level singleton (existing — see [components/feishu-channel.md](/.agents/components/feishu-channel.md)).
- **Every participating session loads feishu-channel** — the dispatcher and
  each Worker. Each session therefore runs its own feishu-channel MCP server.
- **Exactly one MCP server is the holder.** It wins `connection.lock` (existing
  single-instance election), opens the one inbound WebSocket, and runs the
  router. Every other MCP server is an **endpoint**. The holder is also its own
  session's endpoint — no special case.
- **The holder is co-hosted in a session's MCP server, not a daemon.** It is
  pinned toward the dispatcher session by holder affinity (`connection.lock`
  carries a `role`; a dispatcher-role server preempts a teammate-role holder).
  A standalone long-lived daemon was rejected: a process that outlives session
  cycling becomes a version-upgrade liability with no offsetting gain (decision
  0016, §Consequences).
- **The router is pure process-level code — zero Claude turns.** In the WS
  callback it does only: extract the routing key, look it up in the route
  table, append the raw event to the resource inbox, then let the SDK ACK
  Feishu. Decode, enrichment, and access gating happen later, in the endpoint.

```
        Feishu app  ──(one WS, app-wide event stream)──►  HOLDER
                                                            │  router (pure code)
                                  ┌─────────────────────────┤
                                  ▼                         ▼
                  inbox/doc/<file_token>/        inbox/chat/<chat_id>/
                                  │                         │
                  endpoint of the owning Worker drains its resource inboxes
                                  │
                  decode + enrich + gate → notifications/claude/channel
                                  │
                  <channel source="feishu"> block in that Worker's session
```

## 3. Identity key (residual ruling #1)

A Worker's endpoint is identified by an `endpointId`, derived purely from the
Worker's working directory:

```
canonicalWorkspaceDir = realpath(anchor), then normalized:
    resolve symlinks · strip trailing slash · NFC · case-fold on a
    case-insensitive filesystem
endpointId = "v1:" + sha256(canonicalWorkspaceDir).hex[:16]
```

- **Pure derivation.** No mint, no random UUID, no persisted registry, no
  look-up step. A restart recomputes the identical value. There is **zero
  persistent identity state** — nothing to migrate across a plugin upgrade.
- **Scheme version `v1:`.** A future change to the hashing or normalization is
  an explicit `v2:` migration, never a silent re-identification.
- **The anchor is a single source.** Before implementation, verify whether
  `CLAUDE_PROJECT_DIR` is reliably exported to a plugin stdio MCP server
  process (§13). If it is, use it; otherwise use `process.cwd()`. Either way it
  is the **only** source — there is no runtime `CLAUDE_PROJECT_DIR`→`cwd`
  fallback chain. A fallback chain can silently resolve differently between two
  restarts of the same Worker and orphan its routes; on an unusable anchor the
  endpoint fails loudly instead.

### Ruling #1 — no `basename` prefix

The identity is the bare versioned hash. It is **not** prefixed with the
workspace directory's `basename`.

Reason: in this design `endpointId` is used in exactly one place — as the
`ownerId` field inside a route file (§4). It is **never a filesystem path
component**: the inbox is resource-keyed (ruling #2), and liveness is embedded
in the route file (§6), so there is no `endpoints/<endpointId>/` directory. The
operability that a `basename` prefix would buy is already served by the
`ownerWorkspace` field sitting next to `ownerId` in the same route file — an
operator reading a route file sees the full canonical path directly. A prefix
would add value only if `endpointId` were ever displayed without that path
beside it; it is not. Dropping the prefix also drops the `basename`
sanitization step entirely. Any log line that prints `endpointId` must also
print `ownerWorkspace`.

**Guard:** this ruling is contingent on rulings #2 and §6 holding. If a future
revision ever makes `endpointId` a filesystem path component, the `basename`
question — and its sanitization requirement — reopens.

## 4. Route table and inbox (residual ruling #2)

On-disk layout under `~/.claude/channels/feishu/`:

```
routes/
  doc/<file_token>      route file — JSON, see below
  chat/<chat_id>        route file — JSON, see below
  default-sink          JSON: { schema, ownerId, ownerWorkspace }
  .gc/<kind>/<resource>.<nonce>   tombstone — a route mid-GC (§7)
inbox/
  doc/<file_token>/     <ts_ns>-<event_id>.json   one raw event per file
  chat/<chat_id>/       <ts_ns>-<event_id>.json
  _unrouted/            <ts_ns>-<event_id>.json   events with no matching route
  _deadletter/          <ts_ns>-<event_id>.json   events with no route and no default sink
```

Route file content (small JSON; **single-writer = the owning endpoint**, except
the holder's GC tombstone rename, §7):

```jsonc
{ "schema": 1,
  "ownerId": "<endpointId>",            // pure-derived identity; equality key
  "ownerWorkspace": "<canonical path>", // operability + rename anchor (§9)
  "attachedPid": 12345,                 // liveness — refreshed on (re)attach
  "attachedNonce": "a1b2c3",            // attach generation token (§6, §7)
  "attachedAt": 1747900000,
  "selfSubscribed": true,               // did we enable the Feishu doc subscribe
  "claimedAt": 1747900000 }
```

- **Route files are keyed by Feishu resource**, `wx`-created so the first
  creator is the sole owner (§10.1).
- **The inbox is keyed by resource, not by identity** — `inbox/doc/<file_token>/`,
  one raw-event file per event, written `.tmp`→`rename` so a partial write is
  never observed.

### Ruling #2 — resource-keyed inbox, no reader lock

The inbox is `inbox/doc/<file_token>/`, **not** `inbox/<endpointId>/`. There is
no separate per-inbox reader lock.

Reason: with a resource-keyed inbox the holder never resolves an owner identity
on the hot path — it writes to `inbox/<kind>/<resource>/` directly. The reader
of `inbox/doc/X/` is, by construction, the single owner of `routes/doc/X`; the
route's `wx` single-owner claim **is** the inbox's single-reader guarantee, so
no second lock and no second failure mode are needed. A `takeover` (§7) keeps
the inbox directory continuous — only the watcher changes, no in-flight events
are stranded. An identity-keyed inbox would reintroduce the owner-lookup
indirection and a separate lock for no gain.

## 5. Holder router and endpoint delivery

**Holder router** — per event, in the WS callback, synchronous and sub-millisecond:

1. Extract the routing key: `im.message.receive_v1` → `chat_id`;
   `drive.notice.comment_add_v1` → `file_token`. The comment event carries the
   file token in its payload (`notice_meta`, decoded by the SDK — see
   [decision 0011](/.agents/decisions/0011-feishu-doc-comment-enrichment.md));
   extraction is a pure local decode, **no network I/O**, to stay inside
   Feishu's ~3 s ack budget.
2. Resolve the target inbox:
   - `routes/<kind>/<resource>` exists → `inbox/<kind>/<resource>/`.
   - No route, but `routes/default-sink` exists → `inbox/_unrouted/`.
   - No route and no default sink → `inbox/_deadletter/`, and log loudly.
3. Append the raw event: write `<ts_ns>-<event_id>.json.tmp`, then `rename`.
4. **Only after the rename returns** does the callback return, letting the SDK
   ACK Feishu. Ack-after-durable-write: an event Feishu considers delivered is
   already on disk. If the holder dies between `rename` and ACK, Feishu
   redelivers; the holder writes the event a second time (a distinct `<ts_ns>`,
   same `event_id`); endpoint dedup by `event_id` (below) absorbs the duplicate.

The router does no decode, no enrichment, no access gate, no owner-identity
resolution. It is a small pure function (`extract key → table lookup → append`)
and must be exhaustively unit-tested. The holder routes by resource key only
and **never reads `ownerWorkspace`** — a directory rename (§9) does not touch
the holder's hot path.

**Endpoint delivery** — each endpoint, on startup and on every reattach:

1. Compute `endpointId` (§3).
2. Scan `routes/` for route files whose `ownerId == endpointId` — those are
   this Worker's. Self-heal during the scan: §8.
3. Refresh `attachedPid` / `attachedNonce` (fresh per process) / `attachedAt`
   in each owned route. The endpoint whose `endpointId == routes/default-sink`'s
   `ownerId` **additionally** owns `inbox/_unrouted/`.
4. For each owned resource inbox: **register the `fs.watch` first, then drain
   the existing backlog** — watch-before-drain, so an event arriving during the
   drain still produces a callback rather than being missed until the next poll
   tick. Keep a poll fallback (`fs.watch` is not reliable on every platform).
5. Also `fs.watch` the `routes/` tree — to notice a `takeover` (an owned
   route's `ownerId` changed) and a GC tombstone of an owned route (§7).
6. Per event file: existing handler pipeline (decode + enrich + access gate) →
   `notifications/claude/channel` into this session's `<channel>` block →
   delete the event file. Dedup by `event_id` / `message_id`.

**Delivery order is best-effort.** The `<ts_ns>` filename prefix is the
holder's receive time and is the intended drain order, but under a burst the
`rename` order need not match `<ts_ns>` order, and a redelivered event arrives
late. The endpoint and handlers must tolerate out-of-order arrival — e.g. a
`comment_reply` before its parent `comment_add`. Doc-comment enrichment already
fetches the whole thread (decision 0011), so a reply event is self-sufficient;
strict causal ordering is **not** a guarantee this protocol makes.

## 6. Liveness

Liveness is **embedded in the route file** — `attachedPid`, `attachedNonce`,
`attachedAt` — refreshed by the owning endpoint on every (re)attach. There is no
separate `endpoints/<endpointId>/heartbeat` directory; folding liveness into the
route file removes a state class and keeps `endpointId` purely route-file
content (which is what makes ruling #1 clean).

The holder's GC probes liveness with `kill(attachedPid, 0)`. `attachedNonce`
distinguishes process generations (a fresh attach writes a fresh nonce) and is
the compare-and-swap token GC uses to avoid destroying a just-reattached route
(§7). A PID-reuse false positive — a dead Worker's PID reused by an unrelated
process, read as "alive" — only **delays** GC of an abandoned route; it never
loses an event and never crosstalks. It is a named low-probability residual
(§10.7).

## 7. Lifecycle — process death never unsubscribes

A route is deleted **only** by an explicit `unwatch`, an explicit `takeover`,
or holder TTL GC. Process death, `/clear`, and `/resume` never delete a route
and never unsubscribe from Feishu.

| Event | What happens | Route / subscription |
|---|---|---|
| `/clear`, `/resume` | The `claude` process does not restart; the MCP server does not restart; `endpointId` in memory is unchanged | Non-event. Routes untouched. |
| Real restart (crash + `claude --resume`, reboot) | New MCP server, same cwd → same `endpointId` | New process rescans `routes/`, reattaches, drains inbox backlog. Zero Claude involvement, zero re-subscription. |
| Explicit `unwatch_doc(X)` | Worker's Claude calls the tool | Delete `routes/doc/X` + `inbox/doc/X/`. If `selfSubscribed`, call Feishu `delete_subscribe`. |
| `takeover` | Another Worker calls `watch_doc(X, takeover:true)` | `routes/doc/X` `ownerId`/`ownerWorkspace` rewritten; old owner's `routes/` watch sees the change and drops X; new owner watches `inbox/doc/X/` (directory continuous). |
| Abandoned (Worker never returns) | `attachedPid` dead **and** route dormant past a long grace TTL | Holder lazy GC, tombstone protocol below. On final delete: emit a "resource X abandoned, N unread" notice to the default sink — never a silent drop (§12). |

### GC tombstone protocol (resolves the GC-vs-reattach race)

A naive "GC decides, then `unlink`s the route + inbox" races a concurrent Worker
restart: the endpoint reattaches and refreshes liveness between the decision and
the delete, and GC then destroys a freshly-live route and an undrained backlog.
GC therefore runs as a tombstone sequence, not an unlink:

1. **Re-read** the route file immediately before acting. If `attachedNonce` or
   `attachedAt` differs from the value the GC decision was taken on, **abort** —
   the owner reattached.
2. **Tombstone:** atomically `rename` `routes/<kind>/<res>` →
   `routes/.gc/<kind>/<res>.<nonce>`. The rename is the commit point.
3. **Quiesce:** wait a quiesce interval. The owning endpoint's `routes/` watch
   (§5 step 5) sees its route vanish; it treats a tombstoned-or-missing route it
   believed it owned as a re-claim trigger and re-`wx`-creates `routes/<kind>/<res>`.
   A re-claim during quiesce aborts the GC (step 4 finds the route present).
4. **Finalize:** if after the quiesce interval `routes/<kind>/<res>` was not
   re-created, delete the tombstone and `inbox/<kind>/<res>/`, and emit the
   abandonment notice. The inbox is **not** deleted before this point, so events
   survive the whole window.

GC **does not** call Feishu `delete_subscribe`. A Feishu app-level subscription
has no reference count; auto-unsubscribing on GC could silence a subscriber
outside our system. An orphaned subscription only produces noise into the
default sink — the safe failure.

Restart vs "no longer responsible" is distinguished by **explicit intent**:
`unwatch`/`takeover` are explicit calls; a process vanishing is not. While an
owner is gone, events keep buffering in the resource inbox (resource-keyed, so
owner-agnostic) and are drained on reattach — that is what "delivery is not
lost" means.

## 8. Reconciliation self-heal (must-fix #1)

On endpoint startup, the route scan (§5) also self-heals scheme drift: for any
route whose `ownerWorkspace`, re-canonicalized, equals this Worker's
`canonicalWorkspaceDir`, the route is this Worker's even if its `ownerId` does
not match the freshly computed `endpointId` — which can happen across a `v1:`→`v2:`
scheme migration or an unforeseen normalization change. The endpoint rewrites
the drifted `ownerId` to its current value.

**Must-fix #1 — the reconciliation rewrite must be atomic and concurrency-safe.**
This is the one write path unique to the pure-derived design and it must not
corrupt a route file:

- Every route-file rewrite goes through `<file>.tmp` → `rename` (atomic
  replace). A crash mid-write leaves only a `.tmp` file, never a half-written
  route file.
- Only the owner reconciles its own routes (matched by `ownerWorkspace`).
- Two `claude` sessions in the same cwd (a named pathology, §10.4) could both
  reconcile the same route — last-writer-wins via `rename` is still consistent
  because both write the same `ownerId`.

Self-heal handles **scheme drift only**; path drift is §9. A route that suffers
both at once is a named residual (§10.7).

## 9. Directory rename / move (must-fix #2)

Renaming or moving a Worker's directory changes `realpath(cwd)`, hence
`endpointId`. The reconciliation scan (§8) then finds nothing — every route
still carries the **old** `ownerWorkspace`. The Worker's routes are orphaned.
This is a limitation **shared by every design whose anchor is the directory
path**; it is not unique to the pure-derived identity. (The holder is
unaffected — it routes by resource key, never by `ownerWorkspace`.)

**Must-fix #2 — stale `ownerWorkspace` must have an explicit rule, not an
implicit gap:**

- A route whose `ownerWorkspace` no longer `realpath`-resolves to an existing
  directory (or resolves to a different canonical path) is **stale-owned**.
- A stale-owned route is GC-eligible by the same dormancy TTL as any abandoned
  route (§7), with the same abandonment notice.
- A `rebind` maintenance operation is provided: given an old→new workspace
  pair, it scans routes whose `ownerWorkspace` matches the old path and
  rewrites `ownerId` + `ownerWorkspace` to the new Worker. It is O(N) in the
  Worker's subscription count (typically 1–3) and uses the same atomic
  `.tmp`→`rename` as §8.
- Until `rebind` or GC, events for the renamed Worker's resources keep
  buffering in the resource inboxes — a rename followed by a `rebind` within
  the grace window loses nothing.

## 10. Resolved under-specified points

### 10.1 First-claim race

`watch_doc` / `watch_chat` create the route file with `wx` (`O_EXCL`) — exactly
one creator wins. The loser reads `ownerId`: equal to self → idempotent success;
otherwise → return the current owner and require `takeover:true` to override.
`watch_doc` writes the route file **first**, then calls the Feishu subscribe API
— so once Feishu can emit events for the resource, the route already exists. An
event the holder routes in the instant before the route file lands goes to
`inbox/_unrouted/`; no loss — the dispatcher drains the default sink and the new
owner drains its resource inbox from then on.

### 10.2 Stale-claimant detection

The route-embedded `attachedPid` is the liveness probe (§6). Holder GC reclaims
a route only when `attachedPid` is dead **and** the route is dormant past the
grace TTL, via the tombstone protocol (§7) that re-checks `attachedNonce` so a
concurrent reattach aborts the GC. The buffering inbox means a slow restart
never loses events inside the window.

### 10.3 Holder / Worker startup ordering and backlog bounds

Events can arrive before the target Worker's MCP server exists. The resource
inbox is a durable mailbox that absorbs this. Every inbox directory —
`inbox/doc/*`, `inbox/chat/*`, and `inbox/_unrouted/` — is **bounded**: an inbox
event has a maximum age (the grace TTL) and each inbox has a maximum event
count. On overflow the oldest events are dropped **with a logged and surfaced
notice** — never silently. A reattaching Worker drains whatever backlog its
resource inboxes hold. `inbox/_deadletter/` is operator-facing: bounded by age,
not auto-drained, and every write to it is logged loudly.

### 10.4 Cross-repo path collision (named non-goal)

Two distinct checkouts that canonicalize to the same path — bind mounts, a
container-vs-host view, a repo plus a symlink that `realpath` collapses — yield
the same `endpointId`. Likewise two `claude` sessions launched in the **same**
directory share one `endpointId`, both believe they own the same routes, and
both drain the same resource inboxes. claudemux's deployment model — one
teammate session per sibling repo directory, enforced by `tm` — does not
trigger either case. They are **named non-goals**: an endpoint may warn on
attach if it finds another live `attachedPid` on a route it claims, but full
disambiguation is out of scope.

### 10.5 Default-sink lifecycle

`routes/default-sink` is written by the `claim_default_sink` MCP tool, which the
dispatcher calls at startup; the write is an atomic `.tmp`→`rename` (last claim
wins — it is a single coordinating role, not a contended resource). Its content
is `{ schema, ownerId, ownerWorkspace }` — no liveness fields, no `selfSubscribed`.
If the default-sink owner dies, `inbox/_unrouted/` keeps buffering, bounded
(§10.3), until the dispatcher restarts and re-claims. If `routes/default-sink`
is absent entirely, unrouted events go to `inbox/_deadletter/` with a loud log
(§5 step 2). The default sink is not subject to the §7 abandonment GC — it holds
no Feishu subscription; a stale `default-sink` file is simply overwritten by the
next `claim_default_sink`.

### 10.6 Holder handoff event-loss window

A holder is co-hosted in an MCP server (§2) and can be lost — the dispatcher
session ends, the process crashes, or holder affinity preempts it. Between the
old holder's WebSocket closing and a new holder's WebSocket opening, Feishu
events are dropped **at the source** — they reach no inbox. Ack-after-durable-write
(§5 step 4) protects against a holder crash *mid-event*; it does **not** cover
the no-holder gap.

- A **clean** handoff (the holder's session ends normally, or affinity preempts
  it) must hand off before closing the WS: the departing holder holds the WS
  until a successor has opened its own, or at minimum signals the successor and
  shrinks the gap to election latency.
- A **crash** handoff has an irreducible gap = standby takeover-detection
  latency.
- Feishu redelivers events it has not received an ACK for, within a limited
  replay window; whether that window covers a realistic handoff gap is an open
  item (§13). The handoff window is a **known exposure**, not a solved problem;
  shrinking it (clean-handoff signalling, faster standby detection) is the
  follow-up named in decision 0016.

### 10.7 Named residuals

- **PID reuse** (§6): a reused PID read as "alive" only delays GC; no loss, no
  crosstalk.
- **Double drift** (§8): a route that is both scheme-drifted and path-drifted at
  once matches neither the §8 self-heal (path no longer equal) nor a plain
  `rebind` keyed on the old hash scheme. Low probability; recovered by GC +
  re-subscribe, or by a `rebind` that matches on `ownerWorkspace` alone and
  recomputes `ownerId` under the current scheme.

## 11. Isolation guarantee

Worker A receives exactly the events for the resources A claimed. The guarantee
rests on **two** points, both of which must be correct:

1. **Holder key extraction (§5 step 1).** The holder must extract the right
   `file_token` / `chat_id` from each event. A mis-extraction routes an event
   into the wrong resource inbox. This is why §13 keeps the comment-event field
   path an explicit verify item and why the router is exhaustively unit-tested.
2. **Single-owner route claim (§4, §10.1).** `inbox/<kind>/R/` is drained only
   by the single `wx`-owner of `routes/<kind>/R`; `takeover` is explicit.

Given both, isolation is **structural**: A's events physically never enter a
resource inbox A does not own. It is not Feishu-enforced — it is user-space,
resting on holder-router correctness plus the single-owner route. The router is
a small pure function; that unit-test surface is the guarantee's enforcement.

## 12. Required tests and contracts

- **`subscribe → /clear` regression test.** `watch_doc(X)` → `/clear` → assert
  X's subscription and event delivery still work. This is the single most
  important test for this feature: an identity keyed on Claude Code's
  `session_id` would fail it (`session_id` rotates on `/clear` — see
  [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md)),
  and the cwd-anchored identity must pass it.
- **GC-vs-reattach test.** Tombstone a route, reattach concurrently, assert the
  re-claim aborts GC and no inbox event is lost (§7).
- **TTL GC abandonment notice.** GC reclaiming a dormant route must emit a
  "resource X abandoned, N unread events" notice to the default sink (§7).
- **Comment-reply meta contract.** The doc-comment `<channel>` block's `meta`
  must carry `file_token` + `comment_id` (plus `file_type`, `reply_id`,
  `is_whole_comment`) so a `comment_reply` issued several turns later can locate
  the thread without relying on process memory.

## 13. Open items to verify before implementation

- **`CLAUDE_PROJECT_DIR` exposure.** Whether Claude Code exports
  `CLAUDE_PROJECT_DIR` to a plugin stdio MCP server process. This decides the
  single anchor source (§3). Must be settled before implementation; there is no
  runtime fallback either way.
- **Comment-event `file_token` path.** [Decision 0011](/.agents/decisions/0011-feishu-doc-comment-enrichment.md)
  established that the `drive.notice.comment_add_v1` payload carries the file
  token under `notice_meta`, decoded by the SDK's `normalizeComment`. Confirm
  the holder can extract it through a **pure local decode** (no network call),
  as §5 requires for the 3 s ack budget.
- **`event_id` extraction.** §4 names inbox files `<ts_ns>-<event_id>.json` and
  §5 dedups on `event_id` / `message_id`. Confirm every routed event type
  carries a stable id extractable by pure local decode.
- **Feishu un-acked replay window.** §10.6 leans on Feishu redelivering
  un-acked events. Confirm the replay window and whether it covers a realistic
  holder-handoff gap.

## 14. Independent architecture review

This spec was reviewed once by an independent architecture-review subagent
(`Plan`, the standing advisor stand-in — the environment has no dedicated
`advisor` tool). What it flagged and the disposition:

| Review finding | Disposition |
|---|---|
| §11 "isolation enforced at one point" over-claims; key extraction is a second point | **Accepted** — §11 rewritten to two points (key extraction + route claim). |
| §5 step 2 / `_unrouted` incoherent: `_unrouted`/`_deadletter` undeclared in the layout; "default-sink owner's resource inboxes" is circular; who drains `_unrouted` is unstated; `_unrouted` has no bound | **Accepted** — §4 layout now declares `inbox/_unrouted/` + `inbox/_deadletter/`; §5 step 2 rewritten as a flat decision; §5 step 3 states the default-sink owner additionally owns `inbox/_unrouted/`; §10.3 bounds it. |
| §7 GC can race a concurrent reattach and destroy a freshly-live route + backlog | **Accepted** — §7 now specifies the tombstone protocol: nonce re-check, rename-to-tombstone, quiesce with re-claim, delete-last. |
| Holder-handoff no-holder window drops events at the source — unaddressed | **Accepted** — added §10.6; added the Feishu replay-window verify item to §13. |
| §5 endpoint "drain then watch" misses events arriving between drain and watch registration | **Accepted** — §5 endpoint step 4 changed to watch-before-drain. |
| `event_id` extractability never verified | **Accepted** — added to §13. |
| Inbox delivery ordering under burst / redelivery is unstated | **Accepted** — §5 states delivery is best-effort-ordered; strict causal ordering is explicitly not guaranteed. |
| `default-sink` has no lifecycle (creation, takeover, owner death) | **Accepted** — added §10.5. |
| Ruling #1 is contingent on `endpointId` never becoming a path component | **Accepted** — added the guard line to §3. |
| Redelivery-produces-duplicate-files is an unstated assumption | **Accepted** — made explicit in §5 step 4. |
| A route with both scheme drift and path drift matches neither §8 nor §9 | **Accepted** — named as a residual in §10.7. |
| "Holder is rename-oblivious" should be stated to close the question | **Accepted** — stated in §5 and §9. |

No finding was rejected; the review surfaced four genuine event-loss or
incoherence gaps (`_unrouted` mechanism, GC race, holder-handoff window,
drain/watch ordering) that the pre-review draft did not close.

## See also

- [decision 0016](/.agents/decisions/0016-feishu-worker-scoped-subscription.md) — the decision record: trade-offs, the two rulings, consequences.
- [components/feishu-channel.md](/.agents/components/feishu-channel.md) — the current feishu-channel plugin this feature extends.
- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the `tm`↔hook `/tmp` protocol; the routes/inbox protocol here is a second, independent cross-process file protocol under `~/.claude/channels/feishu/`.
- [decision 0011](/.agents/decisions/0011-feishu-doc-comment-enrichment.md) — the doc-comment payload shape and SDK decode.
