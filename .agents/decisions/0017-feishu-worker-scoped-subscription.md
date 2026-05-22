# 0017 — Feishu Worker-scoped subscription: single-app holder routing on a pure-derived identity

- **Status:** Accepted
- **Date:** 2026-05-22
- **Affects:** `plugins/feishu-channel/`; a new cross-process file protocol under `~/.claude/channels/feishu/`

## Context

Feishu event subscription is **app-level**: one app, one event stream, events
typed by `event_type` and never scoped to a resource. Several long connections
on one app do not split events by resource — Feishu's cluster mode hands each
event to a random connection. There is no connection↔resource binding and no
per-chat subscription dimension.

claudemux runs many Workers concurrently — one Claude Code session per repo. The
product goal is that a Worker which wrote a Feishu doc receives **that doc's
comments and nothing else** pushed into its own session context, with the
dispatcher not on the data path; groups likewise. Feishu provides no mechanism
for this, so the isolation must be built in user space.

A four-round design debate between two teammates, plus an independent
architecture review, converged on the design below. This record exists so the
next agent does not re-litigate the settled questions; the full design contract
is [domains/feishu-worker-routing.md](/.agents/domains/feishu-worker-routing.md).

## Decision

### Topology — single app, co-hosted holder, no daemon

One Feishu app. Every participating Claude Code session (dispatcher and each
Worker) runs a feishu-channel MCP server; exactly one wins `connection.lock` and
becomes the **holder** — it opens the one WebSocket and runs a router. The rest
are **endpoints**. The router is pure process-level code (zero Claude turns): it
extracts a routing key, looks it up, appends the raw event to a resource inbox,
then ACKs Feishu.

A standalone long-lived **daemon was rejected**. A process that outlives session
cycling is a version-upgrade liability — the team's recurring historical pain —
and buys nothing the co-hosted holder lacks. The cost is a holder-handoff window
where events drop at the source; that is a named, bounded exposure, not a reason
to take the daemon.

### Identity — pure derivation, not a borrowed or minted key

A Worker's endpoint identity is `endpointId = "v1:" + sha256(canonical
workspace dir)`, recomputed on every start. Three alternatives were rejected:

- **Claude Code `session_id`** — rotates on `/clear` and interactive `/resume`
  (the reason `on-session-start.sh` exists); it would silently drop every
  subscription on the most common Worker action.
- **`CLAUDEMUX_TEAMMATE_REPO`** — couples an independently versioned plugin to a
  claudemux-injected env var; collapses for non-claudemux users.
- **A minted, persisted UUID in a `workers/<hash(cwd)>` registry** — the
  registry key is itself the cwd hash, so the UUID is no more rename-stable than
  a pure hash; it only adds a persistent state class to migrate on every
  upgrade. Strictly dominated by the pure derivation.

The anchor is a **single source** (no `CLAUDE_PROJECT_DIR`→`cwd` fallback
chain — a chain can resolve differently between restarts and orphan routes).

### Routing — per-resource files, process death never unsubscribes

The route table and the inbox are keyed by Feishu resource
(`routes/doc/<file_token>`, `inbox/doc/<file_token>/`). A route file is
`wx`-created (single owner) and carries `ownerId` (the identity) plus
`ownerWorkspace` (the canonical path, for operability and rename rebind). A
route is deleted **only** by an explicit `unwatch`, an explicit `takeover`, or
holder TTL GC; process death, `/clear`, and `/resume` never delete a route and
never unsubscribe from Feishu.

### The two residual rulings

The debate left exactly two crossed details; both are ruled in the spec:

- **Ruling #1 — no `basename` prefix on the identity.** `endpointId` is used
  only as route-file content, never as a filesystem path component; operability
  is served by the adjacent `ownerWorkspace` field. Bare versioned hash.
- **Ruling #2 — resource-keyed inbox, no reader lock.** The route's `wx`
  single-owner claim *is* the inbox's single-reader guarantee; an identity-keyed
  inbox would reintroduce an owner lookup and a separate lock for no gain.

## Consequences

- **A second cross-process file protocol appears** — `routes/` and `inbox/`
  under `~/.claude/channels/feishu/`, independent of the `/tmp` protocol in
  [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md).
  The path-builder discipline (`CLAUDE.md`) applies to every path in it.
- **Isolation is user-space, not Feishu-enforced.** It rests on two points:
  correct routing-key extraction in the holder, and the single-owner route
  claim. The router is a small pure function; **its exhaustive unit tests are
  the isolation guarantee's enforcement** — there is no platform guarantee
  behind it.
- **The pure-derived identity carries zero persistent identity state** —
  nothing to migrate on a plugin upgrade. That property is the decisive reason
  the UUID registry was rejected.
- **Identity is anchored on the directory**, so a directory rename orphans the
  Worker's routes. This is a shared limitation of any path-anchored design; the
  spec gives it an explicit stale-`ownerWorkspace` GC rule and a `rebind`
  operation rather than leaving it an implicit gap.
- **The holder-handoff window** (old holder's WS closed, new holder's not yet
  open) drops events at the source. Ack-after-durable-write does not cover it.
  It is a named exposure (spec §10.6); shrinking it via clean-handoff signalling
  is the named follow-up.
- **Enforcement guards** the implementation must ship: a `watch_doc(X) →
  /clear → assert still subscribed` regression test (a `session_id`-based
  identity would fail it); a GC-vs-reattach test; pure-function router tests.
- **Versioning:** this record and the spec are pure docs — no version bump. The
  implementation will touch `plugins/feishu-channel/src/`, feature-class for
  that plugin, and must bump its manifest (`CLAUDE.md` versioning rule).

## References

- [domains/feishu-worker-routing.md](/.agents/domains/feishu-worker-routing.md) — the full design contract: protocol layout, lifecycle, the resolved under-specified points, the open verify items, and the architecture-review log.
- [decision 0011](/.agents/decisions/0011-feishu-doc-comment-enrichment.md) — the `drive.notice.comment_add_v1` payload shape and SDK decode the holder's key extraction relies on.
- [decision 0005](/.agents/decisions/0005-feishu-channel-plugin.md), [0006](/.agents/decisions/0006-feishu-channel-event-registry.md), [0008](/.agents/decisions/0008-feishu-channel-launch-without-session-proxy.md) — the feishu-channel plugin this feature extends.
- [components/feishu-channel.md](/.agents/components/feishu-channel.md) — the current plugin.
