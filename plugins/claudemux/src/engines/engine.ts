/**
 * The cross-engine TUI contract. Decision multi-engine-tui-architecture §"Engine interface" sets
 * the shape: every engine implements every method (no `?` optionals),
 * and an operation an engine genuinely cannot perform returns a
 * discriminated result whose `kind` says so. The verb layer formats the
 * result; the engine never decides exit codes.
 *
 * Why "implement everything, discriminate the result" instead of optional
 * methods: a caller that has to write `if (engine.foo)` once will write
 * it twice, then forget the third time. A returned-result is one path
 * for "this engine cannot do this", not two; the type system enforces
 * that every caller switches on `kind` and handles the missing-case
 * arm. Phase 2's concrete engines (Claude, Codex) consume this file
 * unchanged; future engines (gemini, cursor, …) implement the same
 * surface.
 */

import type {
  CompactRequest,
  CompactResult,
  ContextRequest,
  ContextResult,
  DoctorSection,
  EngineCapabilities,
  EngineContext,
  EngineKind,
  EngineSnapshot,
  HistoryRequest,
  HistoryResult,
  InspectRequest,
  KillRequest,
  KillResult,
  LastRequest,
  MemoryRequest,
  ReloadRequest,
  ReloadResult,
  ResumeRequest,
  ResumeResult,
  SendRequest,
  SpawnRequest,
  SpawnResult,
  StatusRequest,
  TeammateListing,
  TeammateStatus,
  TextResult,
  TurnResult,
  WaitRequest,
} from './types'

/**
 * Every `tm` engine implements this interface. The fleet-facing methods
 * (`list`, `status`, `kill`) make `tm ls` / `tm states` / `tm status` /
 * `tm kill` reachable for a teammate that has no tmux session — that
 * line is the load-bearing change in decision multi-engine-tui-architecture's amend.
 */
export interface Engine {
  /** Which engine this is. Mirrors the JSON-recorded identity. */
  readonly kind: EngineKind
  /** Structured capability report — drives verb-side conditional behavior. */
  readonly capabilities: EngineCapabilities

  // Hot path
  spawn(req: SpawnRequest, ctx: EngineContext): Promise<SpawnResult>
  send(req: SendRequest, ctx: EngineContext): Promise<TurnResult>
  wait(req: WaitRequest, ctx: EngineContext): Promise<TurnResult>
  /**
   * Tear down the runtime process / worktree state for `req.name`. The
   * implementation must leave the live identity JSON
   * (`/tmp/teammate-<name>.json`) alone — `killVerb` archives + removes
   * it once the engine returns, so a `tm resume` / `tm history` after
   * the kill can recover the teammate's launch context.
   */
  kill(req: KillRequest, ctx: EngineContext): Promise<KillResult>

  // Fleet visibility — decision multi-engine-tui-architecture amend §"Fleet-visibility verbs"
  list(ctx: EngineContext): Promise<readonly TeammateListing[]>
  status(req: StatusRequest, ctx: EngineContext): Promise<TeammateStatus>

  // Session-shape verbs
  compact(req: CompactRequest, ctx: EngineContext): Promise<CompactResult>
  resume(req: ResumeRequest, ctx: EngineContext): Promise<ResumeResult>
  last(req: LastRequest, ctx: EngineContext): Promise<TextResult>
  ctx(req: ContextRequest, ctx: EngineContext): Promise<ContextResult>
  history(req: HistoryRequest, ctx: EngineContext): Promise<HistoryResult>
  mem(req: MemoryRequest, ctx: EngineContext): Promise<TextResult>
  reload(req: ReloadRequest, ctx: EngineContext): Promise<ReloadResult>

  // Diagnostic
  inspect(req: InspectRequest, ctx: EngineContext): Promise<EngineSnapshot>
  doctor(ctx: EngineContext): Promise<DoctorSection>
}
