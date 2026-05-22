# 0015 — Feishu channel: orphan detection by stdin EOF, not parent-PID polling

- **Status:** Accepted
- **Date:** 2026-05-22
- **Affects:** `plugins/feishu-channel/src/shutdown.ts`

## Context

The channel server is a long-lived MCP process Claude Code spawns per session.
When the parent Claude Code process exits — or drops the server on a
`/reload-plugins` — the server must terminate itself. An orphaned server keeps
its Feishu inbound-connection slot occupied and competes for the
single-instance lock.

`ShutdownCoordinator.watchParent` originally polled `process.ppid` every 10s
and shut down when it became 1 — the `init`/`launchd` re-parent that marks an
orphan. Testing on bun 1.3.11 showed `process.ppid` is captured once at startup
and never refreshed after the process is re-parented: the poll reads the
original parent PID forever, so the orphan check never fires. The backstop was
dead on the channel's actual runtime, and orphaned servers accumulated until a
newer server evicted the lock holder (`4da424b`) — which only ever clears the
one holder, never the standby orphans.

Two replacements were considered:

- **Record the real parent PID at startup, poll `kill -0`.** Still polling, and
  open to PID reuse: once the parent exits, its PID can be recycled to an
  unrelated process and the check reads it as alive indefinitely.
- **Watch stdin for EOF.** The server speaks MCP over a stdio pipe whose write
  end the parent holds. The parent exiting closes that end and stdin reaches
  EOF — an OS-delivered, race-free signal with no PID-reuse hole.

## Decision

`watchParent` shuts the server down on the first `end`/`close` of
`process.stdin`. The parent-exit signal is an injectable dependency
(`OrphanWatchDeps.onParentExit`); the production implementation listens on
`process.stdin`, and tests drive a fake.

The stdio pipe is inherited straight through the indirect
`bun run … start` → `bun run src/server.ts` process tree, so the EOF reaches
the real server process even though an intermediary `bun run` sits between it
and Claude Code. This was confirmed empirically on bun 1.3.11 / macOS: in a
grandparent → parent → child process tree with the child's stdin inherited
from the grandparent's pipe, exiting the grandparent delivered `end` and
`close` on the child's stdin within ~1ms, with the intermediary parent still
alive.

A `/reload-plugins` is expected to be covered too: Claude Code retires the old
MCP server, and whichever way it does so — a termination signal, or closing
the stdio pipe — drives a shutdown here, through the signal handlers or this
stdin-EOF watch respectively. The exact reload mechanism was not verified in
this change and should be confirmed in deployment; the parent-exit case above
was verified empirically.

## Consequences

- No polling and no parent-PID bookkeeping: the server exits the instant the
  parent's pipe end closes, rather than up to one poll interval later.
- The mechanism depends on stdin being the parent-held MCP pipe. That holds for
  every Claude-Code-spawned server — the MCP stdio protocol itself requires it.
  A server started by hand with stdin attached to a terminal exits when that
  terminal closes, which is the same "parent gone" semantics.
- Regression guard: `test/shutdown.test.ts` covers the orphan watchdog against
  an injected `onParentExit` — no shutdown before the signal, shutdown after
  it, and a single exit when the signal repeats (stdin can deliver both `end`
  and `close`). The bun-specific EOF delivery is not mechanically testable
  in-process; the empirical check recorded above stands in for it.

## References

- `plugins/feishu-channel/src/shutdown.ts` — `watchParent`, `OrphanWatchDeps`,
  `defaultOnParentExit`.
- `plugins/feishu-channel/test/shutdown.test.ts` — `shutdown — orphan watchdog`.
- `4da424b` — the lock-eviction fix whose reliance on a leaking runtime this
  decision reduces.
