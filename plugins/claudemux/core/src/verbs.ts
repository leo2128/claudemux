/**
 * The catalog of `tm` verbs the core re-exposes as MCP tools.
 *
 * The core exposes the *whole* `tm` verb set — the migration's exit gate is
 * "reproduces today's `tm` behavior for every verb", so no verb is carved
 * out. Each verb becomes one MCP tool; `core.ts` runs it natively (`native.ts`)
 * or shells out to `tm`, per verb, as the strangler migration moves verbs
 * across. The `help` verb is intentionally absent: the MCP tool schemas are
 * themselves the dispatcher-facing help surface, so a `tm help` passthrough
 * would be redundant.
 *
 * The `summary` strings are short, lifted from `tm --help`. Rich per-argument
 * schemas — "the MCP tool descriptions become the new `tm --help`" — are a
 * Phase D task; until then a verb tool forwards an opaque argument vector.
 * The one exception is the registry-affecting verbs (`registry !== 'none'`):
 * their tools take a required structured `repo` field, because the core keys
 * the registry on the teammate identity and must read it as data, not parse
 * it back out of the argument vector (see `core.ts`).
 */

/** One `tm` verb re-exposed as an MCP tool. */
export interface VerbSpec {
  /** The verb name — also the MCP tool name. */
  name: string
  /** One-line description, shown to the dispatcher in the MCP tool list. */
  summary: string
  /**
   * How invoking this verb changes the teammate registry. `spawn`/`resume`
   * record a teammate, `kill` removes one; every other verb leaves the
   * teammate set unchanged. The core applies this after a successful
   * shell-out (see `core.ts`).
   */
  registry: 'record' | 'remove' | 'none'
}

/** Every `tm` verb the core fronts, in the order `tm --help` lists them. */
export const TM_VERBS: readonly VerbSpec[] = [
  { name: 'send', summary: 'Atomic round-trip: send a prompt to a teammate, wait, print the reply.', registry: 'none' },
  { name: 'spawn', summary: 'Launch a teammate; with --prompt, also bootstrap it atomically.', registry: 'record' },
  { name: 'wait', summary: "Wait for a teammate's next Stop and print the reply.", registry: 'none' },
  { name: 'compact', summary: 'Run /compact on a teammate and verify it completed.', registry: 'none' },
  { name: 'resume', summary: 'Resume a prior conversation for a teammate.', registry: 'record' },
  { name: 'last', summary: "Reprint a teammate's last-turn reply.", registry: 'none' },
  { name: 'kill', summary: "Kill a teammate's tmux session.", registry: 'remove' },
  { name: 'reload', summary: 'Fan out /reload-plugins to one or more teammates.', registry: 'none' },
  { name: 'ls', summary: 'List running teammate tmux sessions.', registry: 'none' },
  { name: 'states', summary: 'One-line fleet snapshot of every teammate.', registry: 'none' },
  { name: 'ctx', summary: 'Report real ctx-window usage for one or more teammates.', registry: 'none' },
  { name: 'history', summary: "Inspect a teammate repo's past sessions.", registry: 'none' },
  { name: 'mem', summary: "Print a sibling repo's auto-memory index.", registry: 'none' },
  { name: 'archive', summary: 'Move a finished task from the active ledger to the archive (reads stdin).', registry: 'none' },
  { name: 'status', summary: "Capture-pane a teammate's live screen (diagnostic).", registry: 'none' },
  { name: 'poll', summary: "Block until a teammate's pane matches a regex (diagnostic).", registry: 'none' },
  { name: 'doctor', summary: 'Self-check: tm path/version, env, tmux, idle dir, active teammates.', registry: 'none' },
  { name: 'ask', summary: 'Borrow an idle codex teammate from the pool, drive one turn on a fresh thread, return the teammate.', registry: 'none' },
]
