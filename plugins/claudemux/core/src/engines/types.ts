/**
 * The shared request / result / value types that the `Engine` interface
 * and every verb-layer default implementation speak in.
 *
 * Decision 0024 §"Engine interface" and §"Capabilities are structured,
 * not stringly-typed" anchor this file. Three rules carry through:
 *
 *  - Every operation result is a discriminated union keyed by `kind`, so
 *    the verb formatter can `switch` exhaustively and TypeScript will
 *    reject a missing case at compile time. There is no `string`
 *    fallback on a capability slot; a future engine adding a mode bumps
 *    the union here in one place.
 *  - Every result includes a `not-supported` variant carrying a short
 *    `reason` string. An engine that genuinely cannot perform a verb
 *    still implements the method and returns this variant — the CLI
 *    surface gives the agent a one-line "why", not a stack trace.
 *  - Teammate names may contain `/` (decision 0024 §"Nested teammate
 *    names"). Path builders treat the name as opaque; engine-specific
 *    encoding (e.g., the Claude engine's tmux session name) lives in
 *    that engine's `persistence.ts`.
 *
 * Phase 1 lands this file as a contract. The engine implementations
 * (Phase 2a for Claude, Phase 2b for Codex) consume it without
 * touching it.
 */

/** The closed set of engine kinds. New kinds extend this union here. */
export type EngineKind = 'claude' | 'codex'

/**
 * A teammate name as it appears on the CLI. Single-segment is the
 * common case; nested segments (e.g., `flow/flow-1`) are allowed.
 * Validation lives in `identity/name.ts` once it lands; this alias
 * documents intent at the call sites.
 */
export type TeammateName = string

/**
 * Shared environment passed to every Engine method. Phase 2 will widen
 * this with the production runtime (file system, process runner, clock,
 * tmux adapter); Phase 1 keeps the surface minimal so engine stubs can
 * already match the contract.
 */
export interface EngineContext {
  /** Wall-clock reader — engines must not call `Date.now()` directly. */
  now(): number
  /** Process environment, scoped per invocation so tests can inject. */
  env: NodeJS.ProcessEnv
}

/**
 * Capabilities reported by an engine. Every slot is a discriminated
 * literal union or a boolean — no `string` fallback. A verb that
 * branches on a capability gets exhaustive `switch` checking.
 *
 * `atomicSend` is the literal `true`, not `boolean`: the verb contract
 * demands atomic round-trips, and an engine that cannot do that does
 * not qualify as a `tm` engine.
 */
export interface EngineCapabilities {
  readonly atomicSend: true
  readonly atomicSpawnPrompt: boolean
  readonly compaction: 'manual' | 'auto' | 'unsupported'
  readonly contextUsage: 'transcript-jsonl' | 'rpc-token-usage' | 'unsupported'
  readonly history: 'transcript-files' | 'rpc-thread-list' | 'unsupported'
  readonly memory: 'claude-project-memory' | 'engine-native' | 'unsupported'
  readonly reload: 'prompt-command' | 'native-command' | 'unsupported'
  readonly resume: 'transcript-id' | 'thread-id' | 'unsupported'
  readonly detachedTurn: 'unsupported' | 'replayable' | 'best-effort-push'
  readonly events: 'push' | 'synthesized' | 'none'
}

/** One typed item emitted within a turn (assistant text, tool call, …). */
export type InteractionItem =
  | { kind: 'assistant-text'; text: string }
  | { kind: 'tool-call'; tool: string; argsJson: string }
  | { kind: 'tool-result'; tool: string; ok: boolean; textOrJson: string }
  | { kind: 'system-note'; text: string }

// ─── Spawn ──────────────────────────────────────────────────────────────

export interface SpawnRequest {
  readonly name: TeammateName
  /** Absolute working directory the engine launches the teammate in. */
  readonly cwd: string
  /** Optional first-turn prompt — when present, spawn is an atomic round-trip. */
  readonly prompt: string | null
  /** Optional caller-supplied wall-clock cap; `null` means unbounded. */
  readonly timeoutMs: number | null
  /** Human-readable display name for fleet listing; null falls back to `name`. */
  readonly displayName: string | null
}

export type SpawnResult =
  | { kind: 'spawned'; name: TeammateName; firstTurn: TurnResult | null }
  | { kind: 'already-exists'; existingEngine: EngineKind }
  | { kind: 'failed'; message: string }

// ─── Send / Wait ────────────────────────────────────────────────────────

export interface SendRequest {
  readonly name: TeammateName
  readonly prompt: string
  readonly timeoutMs: number | null
}

export interface WaitRequest {
  readonly name: TeammateName
  /** A previous turn-id to recover from, when send/spawn aborted before reading. */
  readonly recoverFor: string | null
  readonly timeoutMs: number | null
}

export type TurnResult =
  | {
      kind: 'completed'
      text: string
      items: readonly InteractionItem[]
      context: ContextResult | null
    }
  | { kind: 'failed'; message: string; recoverable: boolean }
  | { kind: 'timed-out'; elapsedMs: number }
  | { kind: 'not-supported'; reason: string }
  | { kind: 'no-op'; reason: string }

// ─── Kill ───────────────────────────────────────────────────────────────

export interface KillRequest {
  readonly name: TeammateName
}

export type KillResult =
  | { kind: 'killed' }
  | { kind: 'not-found' }
  | { kind: 'failed'; message: string }

// ─── Compact / Resume / Reload ──────────────────────────────────────────

export interface CompactRequest {
  readonly name: TeammateName
}

export type CompactResult =
  | { kind: 'compacted' }
  | { kind: 'not-needed'; reason: string }
  | { kind: 'not-supported'; reason: string }
  | { kind: 'failed'; message: string }

export interface ResumeRequest {
  readonly name: TeammateName
  /** Engine-specific identifier (Claude sid / Codex thread id). */
  readonly checkpoint: string
}

export type ResumeResult =
  | { kind: 'resumed'; checkpoint: string }
  | { kind: 'not-found'; reason: string }
  | { kind: 'not-supported'; reason: string }
  | { kind: 'failed'; message: string }

export interface ReloadRequest {
  readonly name: TeammateName
}

export type ReloadResult =
  | { kind: 'reloaded' }
  | { kind: 'not-supported'; reason: string }
  | { kind: 'failed'; message: string }

// ─── Last / Ctx / History / Mem ────────────────────────────────────────

export interface LastRequest {
  readonly name: TeammateName
}

export interface ContextRequest {
  readonly name: TeammateName
}

export type ContextResult =
  | { kind: 'usage'; tokensUsed: number; tokensTotal: number; pct: number }
  | { kind: 'not-supported'; reason: string }
  | { kind: 'failed'; message: string }

export interface HistoryRequest {
  readonly name: TeammateName
  /** `null` = list view; non-null = detail of the given turn index. */
  readonly index: number | null
}

export type HistoryResult =
  | { kind: 'list'; turns: readonly HistoryTurn[] }
  | { kind: 'detail'; turn: HistoryTurn; items: readonly InteractionItem[] }
  | { kind: 'not-supported'; reason: string }
  | { kind: 'failed'; message: string }

export interface HistoryTurn {
  readonly index: number
  readonly startedAt: number
  readonly summary: string
}

export interface MemoryRequest {
  readonly name: TeammateName
}

/**
 * Plain-text payload — used for `mem`, `last`, and any other verb whose
 * engine result is "here are some bytes, render them as-is".
 */
export type TextResult =
  | { kind: 'text'; text: string }
  | { kind: 'not-supported'; reason: string }
  | { kind: 'failed'; message: string }

// ─── Fleet visibility (list / status) ──────────────────────────────────

/**
 * One row of `tm ls` — the cross-engine listing default impl concatenates
 * what every engine returns. Engines stay free to add engine-private
 * fields by extending `extras`; the verb formatter ignores unknown keys.
 */
export interface TeammateListing {
  readonly name: TeammateName
  readonly engine: EngineKind
  readonly state: 'idle' | 'busy' | 'unknown'
  readonly cwd: string
  readonly displayName: string | null
  readonly extras: Readonly<Record<string, string>>
}

export interface StatusRequest {
  readonly name: TeammateName
  /** Verb-layer hint for scrollback depth (status pane capture). */
  readonly lines: number | null
}

export type TeammateStatus =
  | {
      kind: 'present'
      name: TeammateName
      engine: EngineKind
      state: 'idle' | 'busy' | 'unknown'
      cwd: string
      pane: string | null
      diagnostics: Readonly<Record<string, string>>
    }
  | { kind: 'not-found' }
  | { kind: 'failed'; message: string }

// ─── Doctor / Inspect ───────────────────────────────────────────────────

export interface InspectRequest {
  readonly name: TeammateName
}

export interface EngineSnapshot {
  readonly engine: EngineKind
  readonly name: TeammateName
  /** Free-form key/value diagnostic dump. */
  readonly fields: Readonly<Record<string, string>>
}

/** One section of the `tm doctor` output, contributed by one engine. */
export interface DoctorSection {
  readonly engine: EngineKind
  readonly findings: readonly DoctorFinding[]
}

export interface DoctorFinding {
  readonly severity: 'ok' | 'warn' | 'error'
  readonly summary: string
  /** Optional remediation hint shown after the summary line. */
  readonly fix: string | null
}
