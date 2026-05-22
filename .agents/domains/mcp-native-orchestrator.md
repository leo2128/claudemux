# Domain: the MCP-native orchestration core (the `next` line)

> **Status:** design spec — not yet implemented. **Target:** the `next`
> branch, version line **`1.0.0-beta.0`** (a 1.0 beta line developed in
> parallel with `main`'s 0.x). **Decision record:**
> [0018](/.agents/decisions/0018-mcp-native-orchestration-core.md).
>
> This document is the full design contract for the architecture that
> replaces the `tm` script. It is the convergence of a three-round design
> debate between two teammates (a claudemux-side and a Codex-side analyst),
> each round reviewed by an independent architecture-review agent, and a
> final review of this spec (logged in §15). The decision record states
> *that* the architecture was chosen; this document states *what it is*.
>
> Read [0018](/.agents/decisions/0018-mcp-native-orchestration-core.md) first
> for the rationale, then this for the contract.
>
> **Versioning:** this is a pure-docs change. The manifest `version` field is
> not edited here; the `1.0.0-beta.0` number is realized by the release flow
> when implementation lands ([decision 0014](/.agents/decisions/0014-changeset-release-versioning.md)).
>
> **How to read the requirement language.** A statement marked *Requirement*
> is a binding outcome the implementation must meet. Where the *mechanism*
> that meets it is not yet designed, the text says so and points at §13. A
> *Requirement* is never a finished design unless it also describes one.

---

## 1. What this replaces, and why

Today the dispatcher drives teammates through [`bin/tm`](/plugins/claudemux/bin/tm)
— a ~2200-line Bash CLI — plus a hook bundle that reconstructs a turn signal
from marker files (see [components/tm.md](/.agents/components/tm.md),
[components/hooks.md](/.agents/components/hooks.md),
[domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md)).
That design is correct *for hosting Claude Code*, which exposes no first-class
programmatic control surface — so claudemux hand-builds one out of tmux,
`tmux send-keys`, and lifecycle hooks.

OpenAI Codex changes the premise. Codex ships a first-class bidirectional
JSON-RPC protocol (`codex app-server`): `turn/start`, `turn/interrupt`,
`turn/steer`, `turn/completed`, thread persistence, `thread/resume`,
`thread/compact/start`. Everything `tm` hand-rebuilds for Claude Code, Codex
provides natively. Forcing Codex into the tmux-and-scrape model would discard
its protocol and inherit screen-scraping fragility.

The `next` line therefore retires `tm` in favor of a **resident, MCP-native
orchestration core** with **per-agent teammate drivers**. The core is not Bash
— a Bash process cannot be an MCP server or hold resident protocol
subscriptions.

This is a destination, reached by a **strangler migration** (§12), not a
flag-day rewrite.

---

## 2. Scope, and the headline use case

**In scope:** hosting both Claude Code and Codex as teammates; a
model-agnostic dispatcher (the dispatcher may itself be Claude Code *or*
Codex); two interaction modes (§8).

**The headline use case — optimize for this:** Codex as a **cross-model
reviewer / advisor**. Its primary value is supplying a different model
family's judgement during plan negotiation and review — the fourth reviewer
in a `/simplify` pass, the other-model voice in a debate, an advisor. The
architecture is tuned for this (§9), not for long-running coding teammates.

**Out of scope / unchanged:** the channel mechanism (feishu-channel and the
Feishu Worker-scoped routing in
[domains/feishu-worker-routing.md](/.agents/domains/feishu-worker-routing.md))
stays orthogonal — it is a capability of a Claude Code session, not part of
teammate hosting. A2A was evaluated and rejected: it is native to neither
agent, and it models peer task-delegation, not session hosting.

---

## 3. Architecture at a glance

```
   Claude Code dispatcher              Codex dispatcher
          │                                  │
   ┌──────┴───────┐                          │ direct MCP client
   │ Bash shim    │   one Bash(run_in_        │ (ask: blocking long-poll;
   │ (harness     │   background) call;       │  teammate: non-blocking
   │  adapter)    │   MCP hidden inside;      │  send + long-poll await,
   └──────┬───────┘   dispatcher never        │  or turn injection)
          │           sees MCP                │
          │  MCP (non-blocking verbs)         │  MCP
          └─────────────────┬─────────────────┘
                            ▼
        ┌─────────────────────────────────────────┐
        │  claudemux orchestration core            │
        │  (resident process; TS/Bun)              │
        │  · MCP server  — the unified outward face │
        │  · teammate registry — authoritative      │
        │  · resident subscription to each          │
        │    teammate's signal source               │
        │  · failure semantics: timeout ownership,   │
        │    exactly-once delivery, warm-pool        │
        └───────────────────┬─────────────────────┘
        in-process call to the per-agent driver object
        ┌───────────────────┴─────────────────────┐
        │ Codex driver:  codex app-server JSON-RPC  │
        │   — genuinely one process with the core   │
        │ Claude driver: a driver object whose      │
        │   backend is multi-process — tmux + the   │
        │   harness-fired hooks + a /tmp file       │
        │   protocol (§5.1)                         │
        └───────────────────────────────────────────┘
```

The driver *object* is always an in-process module of the core. The Codex
driver is genuinely single-process. The **Claude driver object wraps a
multi-process backend** (tmux, the Claude Code harness's hook scripts, `/tmp`
files); the boundary is real and lives *inside* that driver (§5.1).

**The unifying principle — one invariant, instantiated at both ends:**

> An agent family is not uniform *as a server* and not uniform *as a host*.
> Where it is not uniform as a server, a per-agent **teammate driver** is
> required (Claude Code cannot natively be a callable server; Codex can).
> Where it is not uniform as a host, a per-dispatcher **harness adapter** is
> required (the Claude Code harness cannot hold a tool call open; Codex's
> can). No protocol erases either gap — the driver and the adapter are where
> the gaps are absorbed.

---

## 4. The orchestration core

A single **resident process**. Responsibilities:

- **MCP server — the unified outward face.** The core *is* an MCP server. Any
  MCP-host dispatcher connects to it; the dispatcher is therefore not bound to
  one agent family. The MCP tool schemas + tool descriptions are the API
  surface the dispatcher (LLM) reads — they replace `tm <verb> --help`.
- **Teammate registry — the authoritative source of truth** for the live
  teammate set. It replaces `tmux ls` as the enumeration source: a tmux query
  cannot see a Codex teammate whose thread persists while its connection is
  idle. The registry's on-disk schema, crash recovery, and consistency with
  tmux/driver state are a **spec-phase design task, scheduled as the first
  deliverable of Phase A** (§12) — not deferred past it.
- **Resident subscriptions.** Because the core is resident it holds a live
  subscription to each teammate's signal source — a `codex app-server`
  connection for a Codex teammate, the hook marker files for a Claude
  teammate. Turn completion is observed in real time; no polling, no
  `thread/read` diffing. This is what makes exactly-once delivery (§10.2) and
  deterministic interrupt-race resolution (§10.2) possible.
- **Failure semantics owner** — §10.

### 4.1 The seam vocabulary: what carries a protocol and what does not

MCP is the **dispatcher↔core** protocol and nothing else. Below the core,
name the seams precisely — the spec uses these terms consistently:

- **core ↔ driver object** — an **in-process function call**. The driver
  object is a module of the core. No serialization, no protocol. True for
  both drivers.
- **Codex driver object ↔ Codex** — `app-server` JSON-RPC, *inside* the Codex
  driver. The Codex driver is otherwise single-process.
- **Claude driver object ↔ its backend** — a **versioned cross-language `/tmp`
  file protocol** (§5.1), *inside* the Claude driver. This sub-seam exists
  because the hook scripts are Bash run by the Claude Code harness; it is the
  same `/tmp` protocol as
  [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md),
  now made an explicit versioned contract (§12).

So "core↔driver carries no protocol" means the **core↔driver-object** call.
The Claude driver *internally* owns a file protocol — that is a driver-internal
sub-seam, not the core↔driver seam. Putting MCP on the core↔driver-object call
would add a gratuitous process-and-handshake tax to an in-process function
call; MCP earns its place at dispatcher↔core because those are genuinely
separate processes, possibly on different agent families.

---

## 5. Per-agent teammate drivers

A driver implements an agent-neutral semantic model — the **thread / turn /
item** model, adopted from `codex app-server` because it is a maintained,
already-validated reference shape. Each driver implements a capability-gated
subset; a capability descriptor keyed to **`(agent, transport)`** tells the
core which verbs are real for a given teammate.

One caveat applies to the whole model and is detailed in §5.1: the Claude
driver does not implement the turn model cleanly — it implements a **lossy
approximation** of the turn-completion signal. Treat "the Claude driver
implements the model" as "implements an approximation whose `turn/completed`
correctness is itself a measured property" (§11).

### 5.1 Claude driver — tmux + hooks

Reuses today's mechanism, now encapsulated behind the driver interface:
`tmux new-session`, `tmux send-keys` (the dual-send protocol), the
[`hooks/`](/plugins/claudemux/hooks/hooks.json) bundle, and the `/tmp` marker
protocol ([domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md)).

Honest constraints this driver carries:

- The hook scripts are fired by the **Claude Code harness**, not by claudemux,
  and `/tmp` files are the only IPC. This is an irreducible multi-process
  boundary; the driver *encapsulates* it (it is the driver-internal sub-seam
  of §4.1), it does not eliminate it. On the `next` line the core is TS and
  the hooks stay Bash, so this sub-seam becomes a **cross-language** file
  protocol and must be explicitly versioned (§12).
- The turn-completion signal this driver produces is **lossy and racy**, not
  merely late: [`on-stop.sh`](/plugins/claudemux/hooks/on-stop.sh) documents a
  still-open race where a thinking-then-text multi-API-call turn can extract an
  empty `.last`, plus a 15 s settle poll. So the Claude driver does not
  implement a *clean subset* of the turn model — it implements a lossy
  approximation of the turn-completion signal. Metrics (§11) must measure its
  **correctness**, not only its latency.
- A future *ask-mode* Claude backend, if added, would use `claude -p` headless
  one-shot, **not** this tmux+hook driver — ask mode is bounded and one-shot, so
  it does not need the REPL machinery. The tmux+hook complexity exists only for
  *hosted* Claude teammates.

### 5.2 Codex driver — `codex app-server`

- **Transport: `codex app-server`** — the sole formal Codex transport. v1
  includes `turn/interrupt` and `turn/steer`.
- **`approval_policy: Never`.** A claudemux teammate runs unattended; the
  non-interactive posture is a *requirement* of being a teammate (the same
  reasoning as [decision 0007](/.agents/decisions/0007-teammates-launch-without-askuserquestion.md)
  for Claude). With `Never`, `app-server` issues no server→client approval
  reverse-request — so the Codex driver needs no resident *per-teammate*
  subscriber of its own; the **core's** residency (§4) holds the subscription.
- **`codex exec --json`** — a dev-only convenience for bring-up. It does not
  enter a formal phase: ask mode needs only a short ephemeral turn on
  `app-server`, which `exec` does not improve on.
- **`codex mcp-server`** — not used as the Codex driver transport; it is
  strictly dominated by `app-server` (two tools, no interrupt/steer).
- **The `suspended` turn state** is modeled in the thread/turn/item contract
  for protocol honesty (an `app-server` reverse-request must not crash a
  driver). Because v1 teammates run `approval_policy: Never`, no v1 teammate
  reaches `suspended`; the `answer` verb is defined but is not exercised in
  v1. This is recorded so no v1 dispatcher-side approval UX is built for a
  state nothing reaches.

---

## 6. Model-agnostic dispatcher + the asymmetric adapter

The dispatcher reaches the core over MCP. The dispatcher may be Claude Code or
Codex — both are native MCP clients. What is **not** uniform is how each
dispatcher's harness learns that a teammate turn finished. That gap is the
**dispatcher (harness) adapter**, and it is **asymmetric** — not "symmetric
heterogeneity":

- **Claude Code dispatcher — a thin Bash shim.** The Claude Code harness
  cannot hold a tool call open across an idle period; its only re-entry
  affordance is the Bash tool's `run_in_background`, which re-invokes the agent
  when a backgrounded command exits. So the dispatcher issues **one**
  `Bash(run_in_background)` call to a thin shim. *Inside* the shim: one
  non-blocking MCP `send` to the core, then a block on the core's completion
  (a long-poll MCP `await` call), then the shim exits — and the harness's
  task-notification wakes the dispatcher with the result. The dispatcher sees
  one Bash call; MCP is invisible to it. Verb and wait stay fused into a single
  call, which is what keeps an LLM dispatcher from de-syncing (dispatching a
  turn but never issuing the matching wait).
- **Codex dispatcher — direct MCP, no shim, no Bash.** The Codex harness *can*
  hold a tool call open: an MCP tool call has no default timeout
  (source-verified — the end-to-end behavior is verification item **V2**, §13),
  and the turn remains steerable. So a Codex dispatcher connects to the core's
  MCP server directly.

This is the host-side instantiation of §3's invariant. The adapter adapts a
**harness**, not an agent — it adapts "can this dispatcher's host hold a call
open, and how is an idle agent re-entered."

---

## 7. Completion-awareness — mechanism (a)

The dispatcher's verbs are non-blocking MCP calls; "the teammate's turn
finished" must reach the dispatcher without freezing its agent loop. Three
candidate mechanisms were evaluated; **(a) is chosen, and it is the sole
survivor.**

| Candidate | Mechanism | Verdict |
|---|---|---|
| **(a)** hybrid | non-blocking MCP verbs; completion delivered through a per-dispatcher harness adapter (§6) | **chosen** |
| (b) MCP push | the MCP server pushes a notification that wakes the dispatcher | **refuted on both agent families** — see below |
| (c) poll | the dispatcher periodically calls a non-blocking `check` verb | viable only for a Codex dispatcher, where it folds into (a) as the long-poll; on a Claude dispatcher it dies of (b)'s root cause |

**(b) is refuted on both ends — evidence, self-contained:**

- **Claude Code dispatcher:** an MCP `notifications/claude/channel` notification
  does not wake an idle Claude Code session — the REPL prioritizes stdin and
  does not process channel notifications while idle. GitHub issue
  **`anthropics/claude-code#44380`** ("Channel messages don't wake idle
  sessions"), open as of this writing. The channel mechanism delivers the
  event for display but does not start a turn.
- **Codex dispatcher:** Codex's MCP client routes every server→client
  notification through a log-only handler
  (`rmcp-client/src/logging_client_handler.rs`, Codex source at HEAD
  `b14f11d3`) — there is no notification→turn path. The only way to start a
  turn on an idle Codex agent is `turn/start` (or `turn/steer` mid-turn).

**Root cause, stated once:** an idle Claude Code session cannot be woken
except through the Bash tool's backgrounding affordance. That single fact
kills (b) and (c) for a Claude Code dispatcher and forces (a). For a Codex
dispatcher (c) is viable — verb and wait become one long-poll MCP call — but
that is just (a)'s Codex adapter, not a separate mechanism.

The full round-by-round derivation is in
[decision 0018](/.agents/decisions/0018-mcp-native-orchestration-core.md) and
the debate archive; this section carries only the conclusion and the evidence
an implementer needs.

---

## 8. Two interaction modes

The two modes are **two distinct dispatcher-facing call contracts** — not one
mode with a lifecycle profile flag. They share the Codex driver and the
`app-server` connection; they differ in the contract the dispatcher calls.

| | **Teammate mode** | **Ask mode** (reviewer / advisor) |
|---|---|---|
| Call contract | non-blocking dispatch + asynchronous completion delivery | **blocking call + inline typed return** |
| Dispatcher during the turn | freed — keeps serving the human, dispatches other work | blocked — it has nothing to do until the result returns |
| Where the result lands | a *new* dispatcher turn after wake-up, read via a `collect` verb | the *same* reasoning context that issued the call |
| Claude dispatcher impl | backgrounded Bash call (§6) | foreground / blocking call |
| Codex dispatcher impl | non-blocking `send` + long-poll `await`, or turn injection | long-poll MCP call (§7) |
| Interruptible by the dispatcher? | yes — `interrupt` verb (§10.2) | **no** — the ask dispatcher is blocked in one call and has no turn from which to issue `interrupt`; an ask turn is bounded only by the M5 timeout (§10.1, §11) |

Why ask mode is a separate contract: a cross-model review is a **synchronous
data dependency**. The dispatcher cannot continue its reasoning until the
structured review returns, and the review must land in the *same* context that
asked — routing it through the asynchronous teammate-wake path would split the
dispatcher's reasoning across a turn boundary and lose the thread of its own
argument. Blocking is forbidden for *teammate* mode (§6) and correct for *ask*
mode.

---

## 9. The headline: Codex as cross-model reviewer

Concrete requirements that follow from optimizing for the reviewer use case:

- **Structured output.** The ask verb accepts an `output_schema`; `app-server`'s
  `TurnStartParams.output_schema` carries it natively, so a review returns
  structured findings rather than prose to re-parse.
- **Model / effort selection.** The cross-model value is in choosing a GPT-family
  model; the ask verb exposes `model` and `effort`.
- **Fast cold start.** A review must not pay an 18 s REPL-boot cost. The core
  keeps a **warm `codex app-server`**; an ask runs a short turn on an
  **ephemeral thread** on it (no rollout persistence). The warm pool is shared
  mutable state and a failure surface — its discipline is §10.3.

A future `ask <agent>` interface is agent-parameterized; v1 ships only the
Codex backend (the "cross" in cross-model is Codex). The default routing for
ask mode is **through the core** (a non-blocking verb + the completion
adapter), which preserves dispatcher responsiveness for a long review.
Directly calling `codex mcp-server` as a blocking tool from the dispatcher is a
sanctioned escape hatch only for short or already-blocking calls; the
dispatcher-side instructions (§12, Phase D) state when each applies.

---

## 10. Failure semantics — core design, not an operational detail

A reviewer is now a **blocking dependency** of the work it serves: an advisor
that hangs a `/simplify` pass is worse than no advisor. Failure handling is
therefore core design. §10.1–§10.4 state binding *Requirements*; the
*mechanisms* are spec-phase design tasks (§13) and are flagged as such.

### 10.1 Timeout ownership

A teammate turn may never complete (an `app-server` hang, a model loop, a Claude
pane stuck on a permission prompt the hooks miss). For teammate mode a missed
wake is merely annoying. For **ask mode** a missed wake **hangs the
dispatcher's primary task**.

**Requirement:** the core owns an ask-mode timeout SLA; on expiry it returns a
*typed* "reviewer unavailable" result the dispatcher can reason about ("proceed
with 3 reviewers" vs "abort"). It must never silently hang.

*Open (spec-phase, §13):* the SLA value; whether it is fixed or per-call
configurable; whether a timed-out turn is `turn/interrupt`-cancelled on the
Codex side or left running (a timed-out-but-still-running ephemeral thread is a
warm-pool leak — §10.3).

### 10.2 Exactly-once completion delivery

The core's resident state makes teammate *status* authoritative — but does not
by itself make *delivery* idempotent. The interrupt race: a dispatcher issues
`interrupt` while still awaiting the original turn's completion; if the turn
already completed, the core owes the dispatcher two answers.

**Requirement:** completion is delivered exactly once; `interrupt` returns
either `{interrupted}` **or** `{already_completed, result}` — exactly one,
decided by the core's authoritative live state. The user-named problem "by the
time I interrupt, the turn may be done" is this race: the goal is not to
eliminate it (impossible) but to make it *defined*. This applies to **teammate
mode**; an ask turn is not dispatcher-interruptible (§8).

*Open (spec-phase, §13):* the delivery-token mechanism — where the token
lives, who mints it, its lifecycle, and its behavior across a core crash.

### 10.3 Warm-pool discipline

The warm `codex app-server` of §9 is shared mutable state across ask calls: two
ask calls hitting the same warm server can cross-contaminate thread isolation,
`output_schema`, and model/effort config.

**Requirement:** the warm pool has checkout/return discipline; each ask runs on
its own ephemeral thread; turn configuration is never shared across threads.
"Keep a warm app-server" is, in full, a connection-pool design.

*Open (spec-phase, §13):* pool size; eviction; behavior when the pool is
exhausted as an ask arrives (block, cold-spawn, or typed failure).

### 10.4 Warm-pool member death

A warm `app-server` process can die — idle or mid-ask. This is a first-class
failure mode of the headline use case, distinct from §10.1 (an ask *turn*
timing out) and §10.3 (cross-contamination).

**Requirement:** the core holds a resident liveness check on each warm-pool
member; a member's death surfaces as a typed result to any in-flight ask on it
(not a silent hang), and the core does not hand out a dead member. A
mid-ask death is reported to the dispatcher as the same typed "reviewer
unavailable" shape as an §10.1 timeout, so the dispatcher's flow has one
failure shape to reason about.

*Open (spec-phase, §13):* whether a mid-ask death triggers an automatic
cold-start retry inside the SLA, or fails fast.

---

## 11. Metrics

The spec carries five named metrics; M1 and M3 are the user-named
"turn-end-signal timeliness" and "interrupt-response latency." The targets
below are **order-of-magnitude, to be calibrated in the spec phase**; once
calibrated they become the implementation's measured acceptance criteria.

| Metric | Definition | Order-of-magnitude target (calibrate in spec phase) |
|---|---|---|
| **M1 — completion propagation latency** | teammate turn ends → core observes it via the resident subscription | p95 < ~200 ms (resident subscription; one IPC round-trip) |
| **M2 — wake-delivery latency** | core observes → dispatcher actually holds the result/turn | Claude: shim exit + harness scheduling, ~1 s order; Codex: long-poll return ≈ round-trip |
| **M3 — interrupt-effect latency** | dispatcher requests interrupt → teammate turn actually stops | < ~1–2 s (MCP → core → `turn/interrupt` → Codex cancel) |
| **M4 — interrupt-race window** | the interval in which interrupt and completion can cross | resolved by core authoritative state + delivery token (§10.2) into exactly one typed result — **no undefined behavior** |
| **M5 — ask timeout** | the bounded SLA for an ask-mode turn (also the deadline a §10.4 mid-ask death is reported within) | on expiry → typed "reviewer unavailable" (§10.1) — **never a silent hang** |

**Signal correctness, not only latency.** M1 measures latency; for the Claude
driver the turn-completion signal can also be *wrong* (§5.1 — the `on-stop.sh`
empty-`.last` race). The spec-phase metric work must add a **correctness check**
for the Claude driver's `turn/completed`, not just a latency number.

---

## 12. Strangler migration — Phase A–D, no flag-day

Retiring `tm` is a destination; *how* it is retired is a delivery-risk
question, and a flag-day rewrite of a working ~2200-line system is rejected:
it delivers no new user value on its own and concentrates risk. The migration
is a **strangler** — the resident core stands up first and shells out to the
unmodified `tm` per verb, then verbs migrate into the core one at a time.

**One call, end to end, during the migration** (this is the control-flow
inversion the strangler introduces, traced once so §6 and this section join
up): a Claude Code dispatcher issues `Bash(run_in_background)` → the Bash shim
→ an MCP call into the resident core → in Phase A the core *shells out to the
unmodified `tm`* → `tm` drives tmux / the teammate. The core is the new parent
of `tm`; the dispatcher still only ever issues a Bash call.

| Phase | Work | Exit gate |
|---|---|---|
| **A** | **A1:** design the teammate-registry on-disk schema + crash-recovery semantics, and build it. **A2:** stand up the resident TS core; for every verb it **shells out to the unmodified `tm`**; wire the MCP frontend and the resident subscriptions. | A conformance smoke test: the resident core, shelling out to an unchanged `tm`, reproduces today's `tm` behavior for every verb; the registry survives a core restart. `tm` itself is unmodified. |
| **B** | Migrate verbs **one at a time** from "shell out to `tm`" into native core code, **read-only verbs first** (`ls`, `states`, `last`, `history`, `ctx` — low risk), the **hot path last** (`spawn`, `send`, `wait` — racy). The `/tmp` hook protocol becomes an explicit **versioned** cross-language IPC contract here. | Each migrated verb passes the conformance harness against the old `tm` behavior. |
| **C** | Add the Codex driver (`app-server`, `turn/interrupt`/`turn/steer`, warm pool, the §10 failure semantics). | Codex teammates + ask mode work; M1–M5 met. |
| **D** | Retire dead assumptions; the consumer-side agent-aware work — the core's MCP tool schemas/descriptions are the new "`--help`", read by both Claude and Codex dispatchers; the dispatcher instruction port (a Claude Code skill and a Codex equivalent). | The `next` line complete. |

**Phase B is behavior-preserving.** The conformance harness pins each migrated
verb to `tm`'s *current* behavior — **including** the Claude driver's lossy
turn-completion signal (§5.1). Fixing the `on-stop.sh` empty-`.last` race is a
**separate, explicitly tracked item**, not folded into the strangle: a
behavior-preserving migration must not silently also be a behavior change. The
harness's oracle is "what `tm` does today," bug included; the bug fix is its
own change with its own test.

At every point during A–B, `tm` still works; during the migration the Bash
`tm` is a *subprocess of* the resident core, progressively hollowed. There is
no flag-day.

A migration cost to budget explicitly: the Claude driver's hook scripts (in
particular [`on-stop.sh`](/plugins/claudemux/hooks/on-stop.sh)'s jsonl-settle
logic) **stay in Bash** — Claude Code runs them. The marker protocol between a
resident TS core and those Bash hooks becomes the cross-language IPC contract
of §4.1/§5.1; it must be explicitly versioned and tested, and the path-builder
discipline of
[decision 0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md)
applies to every path in it.

**If verification item V2 fails** (§13): the Codex-*dispatcher* path is cut
from the `next` line's v1 scope — v1 ships a Claude Code dispatcher only.
Codex *teammates* are unaffected (the Codex driver is Phase C regardless of
whether Codex can also be a dispatcher); only "Codex as dispatcher" is
amputated, and it becomes a contingent later phase.

---

## 13. Verification ledger — status of every verified claim and open gate

| # | Item | Status | Gates |
|---|---|---|---|
| **V1** | (b) is dead for a Codex dispatcher | **Done** — Codex MCP-client notification handler is log-only (`rmcp-client/src/logging_client_handler.rs`, HEAD `b14f11d3`). | the completion-mechanism choice (§7) |
| **V4** | (b) is dead for a Claude Code dispatcher | **Done (settled negative)** — an MCP `notifications/claude/channel` notification does not wake an idle Claude Code session (`anthropics/claude-code#44380`, open). This also forecloses a would-be in-shim optimization (a Claude shim cannot drop its backgrounded Bash call in favor of a channel push). | the completion-mechanism choice (§7) |
| **V2** | A Codex dispatcher's long-poll is viable end-to-end | **Open — the #1 implementation gate.** Source-verified: an MCP tool call has no default timeout and the turn stays steerable. **Implementation-phase end-to-end test:** a Codex dispatcher, over MCP, calls a core tool that blocks ≥ 5 min; confirm it is not timed out and `turn/steer` still takes effect. | "model-agnostic dispatcher" being real for v1 — see the §12 V2-fail clause |
| **V3** | The Claude shim re-fuses verb+wait | **Open — implementation-phase.** A `claudemux-send` shim does MCP `send` + block-on-completion + exit; the dispatcher issues only one `Bash(run_in_background)` call; confirm the harness task-notification wakes it and M2 is met. | the Claude Code dispatcher path |

The **#1 gate is V2.** "Model-agnostic dispatcher" — a Codex dispatcher — is
real for v1 only if a Codex dispatcher has a working non-blocking completion
path. A fast source check found Codex has substantial async-process machinery
(`unified_exec` with an async watcher and process manager) and that MCP tool
calls have no default timeout, which makes the long-poll path (§7 (c))
plausible — but the end-to-end behavior is unconfirmed and is assigned to the
implementation phase as a go/no-go gate. The §12 V2-fail clause states exactly
what `next`-line v1 loses if V2 fails.

Spec-phase design tasks that must be resolved before the code they shape
(distinct from the verification gates above):

- The teammate-registry schema + crash recovery (Phase A1, §4, §12) —
  **resolved and built in Phase A**; the on-disk contract is
  [components/claudemux-core.md](/.agents/components/claudemux-core.md).
- The core↔Codex-driver internal contract; the `app-server` method subset
  (~8–10 methods) pinned to a generated schema with a CI conformance check.
- The §10 failure-semantics mechanisms: the timeout SLA value, the
  delivery-token mechanism, the warm-pool checkout/return protocol and
  exhaustion behavior, the §10.4 member-death policy.
- The `/tmp` hook protocol's explicit cross-language version contract (§5.1,
  §12 Phase B).
- M1–M5 calibration, and the Claude-driver `turn/completed` correctness check
  (§11).
- The dispatcher instruction port (Phase D): a Claude Code skill and a Codex
  equivalent; the ask-mode "through the core vs escape hatch" guidance.

---

## 14. Invariants carried forward

- **teammate-as-server invariant** — driving a teammate requires the teammate
  to be a callable server; Claude Code cannot natively be one, Codex can. This
  is why the per-agent driver layer cannot be removed by any protocol choice.
- **cross-process / cross-platform invariants** —
  [decision 0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md):
  path-builder discipline and OS-detected helpers still bind every `/tmp`
  protocol path the Claude driver and the hooks share.
- **channel orthogonality** — the channel mechanism
  ([components/feishu-channel.md](/.agents/components/feishu-channel.md),
  [domains/feishu-worker-routing.md](/.agents/domains/feishu-worker-routing.md))
  is not part of teammate hosting and is not touched by this design.
- **non-interactive teammate posture** —
  [decision 0007](/.agents/decisions/0007-teammates-launch-without-askuserquestion.md)
  generalizes: every hosted teammate, Claude or Codex, runs with interactive
  prompting disabled (`AskUserQuestion` disabled / `approval_policy: Never`).

---

## 15. Architecture-review log

Each round of the design debate was reviewed by an independent
architecture-review agent; that round-by-round log is in
[decision 0018](/.agents/decisions/0018-mcp-native-orchestration-core.md) and
the debate archive. This section records the review of **this spec document**
and how each point was handled.

| Review point | Disposition |
|---|---|
| The `/tmp` protocol vocabulary is contradictory — §4.1 said "core↔driver carries no protocol" while §12 calls it "a versioned cross-language IPC contract." | **Adopted.** §4.1 rewritten to name three precise seams: core↔driver-object (in-process call, no protocol), Codex-driver↔Codex (app-server), Claude-driver↔backend (the versioned `/tmp` file protocol, a *driver-internal* sub-seam). §5.1/§12 aligned to that vocabulary. |
| The diagram label "in-process module" over-claims for the Claude driver. | **Adopted.** §3 diagram + caption now state the driver *object* is in-process while the Claude driver's *backend* is multi-process. |
| §5 promises the thread/turn/item model; §5.1 retracts its reliability 20 lines later. | **Adopted.** §5 carries the lossy-approximation caveat inline. |
| `anthropics/claude-code#44380` was cited as settled fact while §13 V4 listed the same question as open — an internal contradiction. | **Adopted (the contradiction); the citation stands.** The citation was verified by the claudemux-side analyst via web search in debate round 3 (a doc not in this reviewer's input set, hence flagged). The real fix is the contradiction: V4 is now marked **Done (settled negative)**, with `#44380` as its evidence — V4 is no longer an open gate. |
| §6's "no default MCP tool-call timeout" is asserted flat, while §13 V2 says the end-to-end behavior is unverified. | **Adopted.** §6 now reads "(source-verified — the end-to-end behavior is V2)". |
| §10 phrases failure-semantics *requirements* as if the *designs* are settled. | **Adopted.** §10 reworded: each item states a binding *Requirement* and an explicit *Open (spec-phase, §13)* for the mechanism. The requirement-language convention is stated in the header. |
| Missing failure mode: warm `app-server` process death. | **Adopted.** New §10.4. |
| Missing: ask-mode interruptibility — §10.2's interrupt race is teammate-mode only; an ask dispatcher is blocked and cannot issue `interrupt`. | **Adopted.** §8's table has an "interruptible?" row; §10.2 scopes itself to teammate mode. |
| Strangler Phase A has no exit gate, and depends on the registry whose design §13 defers — a circular dependency. | **Adopted.** §12 Phase A is split A1 (design+build the registry) / A2 (residency), every phase has an exit gate, and the registry design is named the first deliverable rather than deferred. |
| Phase B has no verb inventory/ordering, and does not say whether the migrated core reproduces `on-stop.sh`'s lossy behavior or fixes it. | **Adopted.** §12 Phase B specifies read-only-verbs-first ordering and rules Phase B behavior-preserving — the lossy signal is reproduced; the `on-stop.sh` fix is a separate tracked item. |
| §6 (the shim) and §12 (the strangler) describe the same call path without visibly joining. | **Adopted.** §12 traces one call end-to-end through the migration-era control-flow inversion. |
| A V2 failure has no stated effect on the Phase plan / scope. | **Adopted.** §12 has an explicit V2-fail clause: Codex-as-dispatcher is amputated from v1; Codex teammates are unaffected. |
| §11's metric targets are hedged "order-of-magnitude" while 0018 calls them "measured acceptance criteria." | **Adopted.** §11 and 0018 aligned: targets are calibrated in the spec phase, then become measured acceptance criteria. |
| §13 was framed "all must pass before implementation" while mixing done and open items. | **Adopted.** §13 is now a verification *ledger* with a per-item status (Done / Open); the open *gates* (V2, V3) are distinguished from the settled items (V1, V4) and from the spec-phase *design tasks*. |
| KB-fit: move §15 (this review log) into decision 0018; provenance belongs in the record, not the contract. | **Not adopted — overridden by an explicit instruction.** The task that produced this spec required the spec to carry an "what the advisor said / adopted or not" section. The round-by-round provenance does live in 0018; this section is the spec-review log the instruction mandates. |

---

## See also

- [decisions/0018-mcp-native-orchestration-core.md](/.agents/decisions/0018-mcp-native-orchestration-core.md) — the decision record and the *why*.
- [components/tm.md](/.agents/components/tm.md) — the `tm` CLI this retires.
- [components/hooks.md](/.agents/components/hooks.md) — the hook bundle the Claude driver keeps.
- [domains/cross-process-protocol.md](/.agents/domains/cross-process-protocol.md) — the `/tmp` marker protocol the Claude driver and the hooks share.
- [decisions/0001-hook-driven-busy-idle-signal.md](/.agents/decisions/0001-hook-driven-busy-idle-signal.md), [0002](/.agents/decisions/0002-atomic-tm-verbs.md), [0007](/.agents/decisions/0007-teammates-launch-without-askuserquestion.md) — the Claude-side design this builds on.
