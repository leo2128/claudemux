# Domain: Feishu Worker-scoped subscription routing

> **Status:** Design spec — converged 2026-05-22 across a four-round design
> debate and one independent architecture review, **not yet implemented**. The
> contract below is what an implementation must satisfy. The settled
> trade-offs and the two residual rulings are recorded in
> [decision 0017](/.agents/decisions/0017-feishu-worker-scoped-subscription.md).

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
  0017, §Consequences).
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
    resolve symlinks · strip trailing slash · NFC · on a case-insensitive
    filesystem, apply full (non-Turkic) Unicode case-folding to the string
endpointId = "v1:" + sha256(canonicalWorkspaceDir).hex[:16]
```

- **Pure derivation.** No mint, no random UUID, no persisted registry, no
  look-up step. A restart recomputes the identical value. There is **zero
  persistent identity state** — nothing to migrate across a plugin upgrade.
- **Scheme version `v1:`.** A future change to the hashing or normalization is
  an explicit `v2:` migration, never a silent re-identification.
- **Case-fold is deterministic — no on-disk lookup.** On a case-insensitive
  filesystem the canonical path is the `realpath` output with **full,
  non-Turkic** Unicode case-folding (the Unicode `C`+`F` fold mappings — *full*,
  not *simple*, so codepoints such as `ß` fold to one deterministic form)
  applied to the entire string. The fold is what makes the identity
  authoritative: the result depends on neither the directory's on-disk stored
  casing nor the casing the Worker process was launched with — both collapse to
  one folded string — and no per-component `stat` is consulted. The exact fold
  variant is fixed into scheme `v1:`; changing it is a `v2:` migration.
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
  default-sink          JSON: { schema, ownerId, ownerWorkspace } — coordination file, not a tombstone-able route (§10.5)
  .gc/<kind>/<resource>.<nonce>   holder-private — a route mid-GC (§7); endpoints never watch this subtree
inbox/
  doc/<file_token>/     <ts_ns>-<event_id>.json   one raw event per file
  chat/<chat_id>/       <ts_ns>-<event_id>.json
  _unrouted/            <ts_ns>-<event_id>.json   events with no matching route
  _deadletter/          <ts_ns>-<event_id>.json   events with no route and no default sink
```

**Resource** route file content (`routes/doc/*`, `routes/chat/*`) — small JSON,
the liveness fields fixed-width so an update is a single write (§6, route-file
write discipline). **Single-writer = the owning endpoint**, except the holder's
GC tombstone `rename` (§7); owner updates are in-place modifications, never
path-creating writes (§6). `routes/default-sink` is **not** a resource route —
it is a coordination file, holds no liveness, is never tombstoned, and is exempt
from this discipline (§10.5).

```jsonc
{ "schema": 1,
  "ownerId": "<endpointId>",            // pure-derived identity; equality key — fixed-width
  "attachedPid": 12345,                 // ┐ liveness region — all fixed-width, at
  "attachedNonce": "a1b2c3",            // │ stable byte offsets, so a §6 liveness
  "attachedAt": 1747900000,             // │ update rewrites a fixed byte range
  "lastSeenAt": 1747900600,             // ┘ (kill probe / GC-abort CAS / dormancy clock)
  "claimedAt": 1747900000,              // first-claim time
  "selfSubscribed": true,               // did we enable the Feishu doc subscribe
  "ownerWorkspace": "<canonical path>" }// operability + rename anchor (§9) — variable-length, serialized last
```

**Field order is part of the contract.** `schema`, `ownerId`, and the four
liveness fields are all fixed-width and serialized **first**, so the liveness
region sits at byte offsets that do not depend on any later field. The
variable-length `ownerWorkspace` is serialized **last**. This is what lets a §6
liveness update overwrite a fixed byte range in place at a known offset; an
identity rewrite that changes `ownerWorkspace`'s length rewrites the whole file
instead (§6, identity rewrite).

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
   this Worker's — and `routes/.gc/` for a tombstone of one of this Worker's
   resources, a GC begun while the Worker was down. Self-heal and tombstone
   re-claim during the scan: §8.
3. Refresh `attachedPid` / `attachedNonce` (fresh per process) / `attachedAt` /
   `lastSeenAt` in each owned **resource route** (`doc/*`, `chat/*`) — an
   in-place update under the §6 write discipline — and start the periodic
   `lastSeenAt` heartbeat (§6). The endpoint whose `endpointId ==
   routes/default-sink`'s `ownerId` **additionally** owns `inbox/_unrouted/`;
   `default-sink` carries no liveness fields and is neither liveness-refreshed
   nor heartbeated (§10.5).
4. For each owned resource inbox: **register the `fs.watch` first, then drain
   the existing backlog** — watch-before-drain, so an event arriving during the
   drain still produces a callback rather than being missed until the next poll
   tick. Keep a poll fallback (`fs.watch` is not reliable on every platform).
5. Also `fs.watch` the `routes/` tree, keyed on this endpoint's **own live
   route paths** `routes/<kind>/<res>`: a `takeover` rewrites a route's
   `ownerId`, and a GC tombstone (§7) makes an owned live path vanish — both are
   re-evaluated against `endpointId`, and a vanished owned path triggers the §7
   re-claim. The `routes/.gc/` subtree is holder-private; the watch never treats
   an entry appearing there as a route, so a leftover or in-flight tombstone
   cannot trigger a spurious re-claim.
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

Liveness is **embedded in the route file** — refreshed by the owning endpoint,
with no separate `endpoints/<endpointId>/heartbeat` directory. Folding liveness
into the route file removes a state class and keeps `endpointId` purely
route-file content (which is what makes ruling #1 clean). Four fields carry it,
and they do **two distinct jobs** — conflating them was the bug fixed below:

| Field | Job | Refreshed |
|---|---|---|
| `attachedPid` | liveness probe — `kill(attachedPid, 0)` | on every (re)attach |
| `attachedNonce` | **re-attach detector** — process-generation token; the compare-and-swap token GC uses to abort on a concurrent reattach (§7) | on every (re)attach — a fresh value per process |
| `attachedAt` | when the current generation attached — operability timestamp, paired with `attachedNonce` | on every (re)attach |
| `lastSeenAt` | **the GC dormancy clock** — the one field that advances while the Worker is healthy | periodically, by a heartbeat, while the endpoint runs |

**Why `lastSeenAt` is a separate field.** `attachedPid` / `attachedNonce` /
`attachedAt` change *only* on (re)attach. If GC measured dormancy as
`now - attachedAt`, that quantity would track a Worker's **uptime**, not its
**abandonment**: a Worker that attaches once and runs healthy for days carries
an `attachedAt` from days ago, so the instant it crashes `now - attachedAt`
already exceeds any grace TTL — the §7 grace window would collapse to zero for
exactly the longest-lived Workers, and a crashed long-running Worker could be
GC'd before its operator runs `/resume`. That would break the promise at the
head of §7. `lastSeenAt` is the fix: the owning endpoint rewrites it on a
periodic heartbeat (interval ≪ grace TTL), so it tracks "last confirmed alive".
When the process dies the heartbeat stops, `lastSeenAt` freezes, and
`now - lastSeenAt` then measures **time since the Worker was last alive** — the
real dormancy. The grace TTL is measured from that, so the full window applies
from the moment of the crash, for every Worker regardless of uptime.

**GC needs both signals.** A route is GC-eligible (§7) only when
`kill(attachedPid, 0)` reports the process dead **and** `now - lastSeenAt`
exceeds the grace TTL. `kill` is the primary liveness check; `lastSeenAt` dates
the grace window. A healthy long-running Worker is never GC-eligible — `kill`
reports it alive — whatever the heartbeat cadence; the heartbeat matters only
for a *dead* process, as the timestamp that dates the window.

The heartbeat is an owner update of an already-owned route file. It writes only
to a route the endpoint still owns, under the write discipline below — an owner
update can never resurrect a route GC has tombstoned.

A **PID-reuse false positive** — a dead Worker's PID reused by an unrelated
process and read as "alive" — only **delays** GC of an abandoned route (the
`kill` probe never clears, though `lastSeenAt` is long stale); it never loses an
event and never crosstalks. It is a named low-probability residual (§10.7).

### Route-file write discipline

The heartbeat — and every other owner update of a route file (the §5 reattach
refresh, the §8 reconciliation rewrite, the §9 `rebind`, the §10.1 `takeover`) —
must not be able to **resurrect a tombstoned route**. An update that created `routes/<kind>/<res>` as a side
effect would let the route re-appear after §7 step 2 tombstoned it; GC would
then finalize against a route a live owner believes it still holds, and delete
that owner's inbox. So every owner update obeys:

- A route file is **brought into existence by exactly two operations** — the
  first-claim `wx` (§10.1) and the §7 re-claim (`rename` the tombstone back).
  Nothing else creates the path.
- An owner update is an **in-place modification of an existing route file** —
  `open` **without** `O_CREAT`. If the file is absent (`ENOENT`) the route was
  tombstoned, or already GC-finalized; the owner does **not** recreate it — it
  diverts to the §7 re-claim, which itself no-ops if no tombstone is found (the
  resource was legitimately abandoned, §8).
- The liveness fields are **fixed-width** — zero-padded integers, a
  fixed-length nonce — and serialized in a leading region ahead of the
  variable-length `ownerWorkspace` (the §4 field-order contract), so every
  liveness update writes the same byte count at the same offsets. A shorter new
  value can never leave trailing bytes of the old one, and the update needs no
  `ftruncate`.
- An **identity rewrite** — `ownerId` / `ownerWorkspace`, performed by
  reconciliation (§8), `rebind` (§9), or `takeover` (§10.1) — is an in-place
  *full* rewrite rather than a fixed-width field update (`ownerWorkspace` is a
  variable-length path, so it `ftruncate`s to the new length). It obeys the
  same `open`-without-`O_CREAT` rule — an absent route diverts to the §7
  re-claim — and the same post-write device+inode verify; a concurrent reader
  is covered by the torn-read backstop below. Identity rewrites are rare,
  explicit operations — not a hot path.
- A concurrent or crash-interrupted read may still observe a torn field, so the
  **reader is the torn-read backstop**: GC's step-1 re-read (and the §8 scan)
  treat unparseable or implausible content as indeterminate, retry a bounded
  number of times, and on persistent failure **abort conservatively** — an
  abort only delays reclamation, never loses an event.
- After the write the owner re-`stat`s `routes/<kind>/<res>` and confirms it
  still resolves to the file just written (same device + inode). A mismatch or
  `ENOENT` means a tombstone `rename` slipped in mid-update — the write landed
  in a now-detached file — and the owner diverts to the §7 re-claim.

This is what makes the tombstone the **sole** arbiter of a route's fate: with no
owner write able to create the route path, GC's `rename`-to-tombstone cannot be
silently undone, and the re-claim `rename`-back versus the finalize `unlink`
(§7) are the only operations that decide the outcome.

## 7. Lifecycle — process death never unsubscribes

A route is deleted **only** by an explicit `unwatch`, an explicit `takeover`,
or holder TTL GC. Process death, `/clear`, and `/resume` never delete a route
and never unsubscribe from Feishu.

| Event | What happens | Route / subscription |
|---|---|---|
| `/clear`, `/resume` | The `claude` process does not restart; the MCP server does not restart; `endpointId` in memory is unchanged | Non-event. Routes untouched. |
| Real restart (crash + `claude --resume`, reboot) | New MCP server, same cwd → same `endpointId` | New process rescans `routes/` + `routes/.gc/`, reattaches or re-claims, drains inbox backlog. Zero Claude involvement, zero re-subscription. |
| Explicit `unwatch_doc(X)` | Worker's Claude calls the tool | Delete `routes/doc/X` + `inbox/doc/X/`. If `selfSubscribed`, call Feishu `delete_subscribe`. |
| `takeover` | Another Worker calls `watch_doc(X, takeover:true)` | `routes/doc/X` `ownerId`/`ownerWorkspace` rewritten; old owner's `routes/` watch sees the change and drops X; new owner watches `inbox/doc/X/` (directory continuous). |
| Abandoned (Worker never returns) | `attachedPid` dead **and** `lastSeenAt` (§6) older than a long grace TTL | Holder lazy GC, tombstone protocol below. On final delete: emit a "resource X abandoned, N unread" notice to the default sink — never a silent drop (§12). |

### GC tombstone protocol

A naive "GC decides, then `unlink`s the route + inbox" races a concurrent Worker
restart: the endpoint reattaches and refreshes liveness between the decision and
the delete, and GC then destroys a freshly-live route and an undrained backlog.
GC therefore runs as a tombstone sequence. The tombstone
`routes/.gc/<kind>/<res>.<nonce>` — `<nonce>` being the `attachedNonce` the GC
decision was taken on — is the **single atomically-contended object**: a
re-claim and a finalize each commit by an atomic operation on it, so exactly one
wins and no leftover tombstone is possible. **At most one tombstone exists per
resource at any time:** step 2's `rename` consumes the single route file, and a
resource absent from `routes/` cannot be tombstoned again until it is
re-created — so a tombstone's `<res>` names exactly one in-flight GC.

1. **Re-read** the route file immediately before acting. If `attachedNonce`
   advanced (a new generation reattached) or `lastSeenAt` advanced (the owner is
   still heartbeating, §6), **abort** — no tombstone exists yet, nothing to
   clean up.
2. **Tombstone:** atomically `rename` `routes/<kind>/<res>` →
   `routes/.gc/<kind>/<res>.<nonce>`. This rename is the commit point and the
   durable record that a GC is in progress for this resource.
3. **Quiesce:** wait a quiesce interval. The owning endpoint, if it returns,
   finds its live route path `routes/<kind>/<res>` gone — via the §5 watch while
   running, or the §8 scan on restart — and **re-claims**: it first refreshes
   liveness *in the tombstone file in place* (an existing file — the §6 write
   discipline applies), then atomically `rename`s the tombstone back,
   `routes/.gc/<kind>/<res>.<nonce>` → `routes/<kind>/<res>`. Refreshing before
   the rename means the route **reappears already carrying current liveness** —
   there is no stale-liveness window in which a fresh GC pass could re-tombstone
   a route a live owner just re-claimed. The re-claim consumes the tombstone, so
   a successful re-claim leaves nothing behind.
4. **Finalize:** after the quiesce interval, `unlink` the tombstone
   `routes/.gc/<kind>/<res>.<nonce>` — this `unlink` is the finalize commit
   point. If it **succeeds**, the GC owns the outcome: delete
   `inbox/<kind>/<res>/` and emit the abandonment notice. If it **fails**
   (`ENOENT`), the owner re-claimed in step 3 and the finalize **aborts** — the
   route and its inbox are left intact for the re-claimed owner. The inbox is
   never deleted before a successful tombstone `unlink`, so events survive the
   whole window.

Re-claim (step 3) and finalize (step 4) both commit through the one tombstone:
the endpoint's `rename`-back and the holder's `unlink` cannot both succeed, so a
route is never both re-claimed and destroyed, and an aborted GC never orphans a
tombstone. This holds only because the route path is reachable by exactly two
creators — no owner route-file write can create it (§6, route-file write
discipline), and a first-claim `watch_doc` of a resource that is mid-GC is
itself routed through the tombstone (§10.1) rather than `wx`-creating a fresh
route beside it. The tombstone is then the one object whose fate decides the
route's.

### Holder crash mid-GC — the `routes/.gc/` recovery scan

If the holder crashes between step 2 and step 4, the route exists only as a
tombstone, with no live `routes/<kind>/<res>` entry. The tombstone is the
durable GC-in-progress record, so the next holder recovers it. **On winning
`connection.lock`, before routing any event, a new holder scans `routes/.gc/`**
and for each tombstone:

- If a live `routes/<kind>/<res>` exists — the owner re-claimed while no holder
  was running — the tombstone is an orphan; `unlink` it.
- Otherwise, resume the GC from step 3: re-run the quiesce wait — which gives a
  late-returning owner a fresh re-claim window — then finalize (step 4).

So `routes/.gc/` is bounded by the number of GCs in flight, and every tombstone
is terminated: by the finalize that created it, by a re-claim, or by the next
holder's recovery scan. It never accumulates.

**Timing constraint.** For a returning owner to always re-claim before finalize
deletes its inbox, the **quiesce interval must exceed the worst-case re-claim
detection latency** — the time for the §5 watch (a running owner) or the §8
startup scan (a restarting owner) to notice the vanished route and issue the
rename-back. The **grace TTL must in turn be much larger than the quiesce
interval**, so an ordinary slow restart never reaches finalize at all. These two
orderings — re-claim detection latency `<` quiesce interval `≪` grace TTL — are
a required property of the chosen intervals, not a free implementation choice.

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

- The reconciliation rewrite is an in-place update under the §6 route-file
  write discipline: it modifies an existing route file in a single write, never
  creates the path, and diverts to the §7 re-claim if the route was tombstoned.
  It therefore cannot resurrect a tombstoned route.
- Only the owner reconciles its own routes (matched by `ownerWorkspace`).
- Two `claude` sessions in the same cwd (a named pathology, §10.4) could both
  reconcile the same route — last-writer-wins is still consistent because both
  write the same `ownerId`.

**Tombstone re-claim.** The startup scan also covers `routes/.gc/`: a tombstone
whose content matches this Worker — by `ownerId`, or by `ownerWorkspace` for the
scheme-drift case — means the Worker returned while a GC of one of its resources
was in progress. The endpoint re-claims it per §7 step 3 — refresh liveness in
the tombstone, then `rename` it back to `routes/<kind>/<res>` — rolling the GC
back. A tombstone the holder already finalized is simply gone: that resource was
legitimately abandoned, and the endpoint starts with no route for it.

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
- A stale-owned route is GC-eligible by the same `lastSeenAt` dormancy TTL as
  any abandoned route (§7, §6): once the Worker restarts under its new path no
  process heartbeats the old-path route, so `lastSeenAt` freezes exactly as on a
  crash. Same abandonment notice.
- A `rebind` maintenance operation is provided: given an old→new workspace
  pair, it scans `routes/` for route files whose `ownerWorkspace` matches the
  old path and rewrites `ownerId` + `ownerWorkspace` to the new Worker. It is
  O(N) in the Worker's subscription count (typically 1–3). Each rewrite is an
  **identity rewrite under the §6 route-file write discipline**: in-place,
  `open` without `O_CREAT`, with the device+inode verify after writing. This is
  load-bearing here — the bullet above makes a stale-owned route GC-eligible, so
  a route `rebind` reaches may be tombstoned mid-operation; the `open`-without-
  `O_CREAT` then returns `ENOENT` and `rebind` diverts that route to the §7
  re-claim instead of resurrecting it. `rebind` is therefore **not** a third
  route-path creator — the §7 two-creator invariant (`wx` first-claim,
  re-claim `rename`-back) holds.
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

**A first-claim of a resource that is mid-GC routes through the tombstone.**
Before the `wx` create, `watch_doc` / `watch_chat` checks `routes/.gc/<kind>/<res>.*`
for an in-flight GC tombstone (§7). If one exists the resource is mid-GC, and
the claim proceeds as a **re-claim** — refresh-and-`rename` the tombstone back
(§7 step 3), then rewrite `ownerId` / `ownerWorkspace` to the new owner — rather
than `wx`-creating a fresh route beside the tombstone. The new owner inherits
the existing `inbox/<kind>/<res>/`. This keeps the tombstone the single
contended object: a fresh claimer and a finalizing GC contend on the same
`rename`-back / `unlink`, so GC can never delete the inbox of a route a new
owner just claimed. A plain `wx` create is correct only when **neither** the
route file **nor** a tombstone exists — and since a tombstone is produced only
by renaming an *existing* route away (§7 step 2), no tombstone can appear for a
resource whose route file was already absent, so the check-then-`wx` is not
itself racy.

A **`takeover`** (`watch_doc(X, takeover:true)`) does not `wx`-create — the
route file already exists, owned by another endpoint. It is an **identity
rewrite** of that route (`ownerId` / `ownerWorkspace` → the new owner) under the
§6 write discipline: in-place, `open` without `O_CREAT`, post-write verify. If
the route was tombstoned between the caller's read and its rewrite, the
`open`-without-`O_CREAT` returns `ENOENT` and the `takeover` diverts to the §7
re-claim — so a `takeover` racing a GC of the same resource also resolves
through the single tombstone, never beside it.

### 10.2 Stale-claimant detection

The route-embedded `attachedPid` is the liveness probe (§6). Holder GC reclaims
a route only when `attachedPid` is dead **and** `lastSeenAt` — the heartbeat
dormancy clock (§6) — is older than the grace TTL, via the tombstone protocol
(§7); the protocol re-checks `attachedNonce` and `lastSeenAt` so a concurrent
reattach or a fresh heartbeat aborts the GC. The buffering inbox means a slow
restart never loses events inside the window.

### 10.3 Holder / Worker startup ordering and backlog bounds

Events can arrive before the target Worker's MCP server exists. The resource
inbox is a durable mailbox that absorbs this. Every inbox directory —
`inbox/doc/*`, `inbox/chat/*`, and `inbox/_unrouted/` — is **bounded**: an inbox
event has a maximum age (sized to the grace TTL, but an inbox timer of its own —
independent of any route's `lastSeenAt` dormancy clock, §6) and each inbox has a
maximum event count. On overflow the oldest events are dropped **with a logged and surfaced
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
next `claim_default_sink`. Because `default-sink` is never tombstoned, a
path-creating `.tmp`→`rename` write of it can resurrect nothing — it is
**exempt from the §6 route-file write discipline**, which governs only the
tombstone-able resource routes (`doc/*`, `chat/*`).

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
  follow-up named in decision 0017.

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
- **Dormancy-clock test.** A Worker that has run healthy well past the grace TTL
  and then crashes must still get the full grace TTL — measured from the crash,
  not from attach — before its route becomes GC-eligible (§6). A clock keyed on
  `attachedAt` instead of `lastSeenAt` would fail this.
- **Holder-crash-mid-GC test.** Crash the holder between tombstone and finalize;
  assert the next holder's `routes/.gc/` recovery scan either rolls the GC
  forward or, if the owner re-claimed, removes the orphan tombstone — with no
  route and no inbox lost either way (§7).
- **Heartbeat-vs-tombstone test.** Tombstone a route while its owner is mid
  liveness update; assert the update does not resurrect the route path, the
  owner's post-write device+inode check diverts it to the §7 re-claim, and GC
  never finalizes (deletes the inbox) against the live owner (§6, write
  discipline).
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

A **second review round** — iterated PR #30 cross-reviews and `Plan` advisor
stand-in re-reviews of the fixes each one prompted — surfaced the gaps below.
Several were caught only after the fix for the previous one landed; the
dispositions record where each was closed. All are folded in:

| Review finding | Disposition |
|---|---|
| GC dormancy was measured off `attachedAt`, which advances only on attach — so it tracked Worker uptime, not abandonment, and the §7 grace window collapsed to zero for the longest-lived Workers | **Accepted** — §6 adds the periodic `lastSeenAt` heartbeat as the dormancy clock; §7 / §9 / §10.2–§10.3 reworded onto it. |
| The GC tombstone protocol left the abort and holder-crash paths undefined: an aborted GC leaked its tombstone, and a holder crash mid-GC had no recovery rule | **Accepted** — §7 makes the tombstone the single atomically-contended object (rename-back re-claim, `unlink`-as-finalize-commit), names the at-most-one-tombstone-per-resource invariant, and adds the holder-takeover `routes/.gc/` recovery scan; §8 adds the restart-time tombstone re-claim. A follow-up advisor pass added: a first-claim of a mid-GC resource is itself routed through the tombstone (§10.1), so no fresh `wx` route can coexist with it and have its inbox destroyed by finalize; the re-claim refreshes liveness *before* the rename-back (§7 step 3), leaving no stale-liveness window; and §7 states the `detection latency < quiesce ≪ grace TTL` timing constraint the no-loss guarantee rests on. |
| §3 "case-fold on a case-insensitive filesystem" did not say which casing is authoritative, nor which fold variant — both feed the identity hash | **Accepted** — §3 specifies full, non-Turkic Unicode case-folding of the `realpath` string, independent of on-disk and launch-input casing. |
| The B2 fix itself: a route-file owner update written by a path-creating `.tmp`→`rename` (the reattach refresh, or the heartbeat) could resurrect a route GC had tombstoned, letting GC finalize against a live owner and delete its inbox | **Accepted** — §6 adds the route-file write discipline: owner updates are in-place (`open` without `O_CREAT`), never create the route path, are a single fixed-**width** write, and verify by device+inode after writing, diverting to the §7 re-claim on any mismatch; the torn-read backstop is placed on the reader (bounded retry, conservative abort). §7's exclusivity claim is now grounded on it. |
| The write-discipline fix moved §8 reconciliation to an in-place write but left §9 `rebind` citing the old `.tmp`→`rename` — a path-creating write that could resurrect a tombstoned stale-owned route (the same resurrection class, on the one route-update path the fix missed) | **Accepted** — §9 `rebind` is now an identity rewrite under the §6 write discipline (in-place, `open` without `O_CREAT`, `ENOENT`→§7 re-claim, post-write verify); the stale cross-reference is removed. §6 names the identity-rewrite class (reconciliation, `rebind`, `takeover`) explicitly. §4 / §5 step 3 / §10.5 mark `routes/default-sink` exempt — it is never tombstoned, so a path-creating write of it resurrects nothing, and it carries no liveness to refresh or heartbeat. A further advisor pass added the §4 field-order contract: the fixed-width liveness fields are serialized ahead of the variable-length `ownerWorkspace`, so §6's fixed-offset liveness update is actually achievable. |

No finding was rejected.

## See also

- [decision 0017](/.agents/decisions/0017-feishu-worker-scoped-subscription.md) — the decision record: trade-offs, the two rulings, consequences.
- [components/feishu-channel.md](/.agents/components/feishu-channel.md) — the current feishu-channel plugin this feature extends.
- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the `tm`↔hook `/tmp` protocol; the routes/inbox protocol here is a second, independent cross-process file protocol under `~/.claude/channels/feishu/`.
- [decision 0011](/.agents/decisions/0011-feishu-doc-comment-enrichment.md) — the doc-comment payload shape and SDK decode.
