/**
 * The shared request / result / value types that the `Engine` interface
 * and every verb-layer default implementation speak in.
 *
 * Decision multi-engine-tui-architecture §"Engine interface" and §"Capabilities are structured,
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
 *  - Teammate names may contain `/` (decision multi-engine-tui-architecture §"Nested teammate
 *    names"). Path builders treat the name as opaque; engine-specific
 *    encoding (e.g., the Claude engine's tmux session name) lives behind
 *    named path builders.
 *
 * Phase 1 lands this file as a contract. The engine implementations
 * (Phase 2a for Claude, Phase 2b for Codex) consume it without
 * touching it.
 */

import type { TmResult } from '../tm'

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
  /**
   * Physical path of the source repository. Equal to `cwd` when
   * `worktreeSlug` is `null` (`--no-worktree`); otherwise the parent
   * of the worktree path.
   */
  readonly repo: string
  /**
   * Runtime working directory the engine launches the teammate in.
   * `repo/.claude/worktrees/<worktreeSlug>` when a worktree is in use,
   * `repo` otherwise.
   */
  readonly cwd: string
  /** Short name of the worktree under `.claude/worktrees/`; `null` for `--no-worktree`. */
  readonly worktreeSlug: string | null
  /** Optional engine-specific resume checkpoint. */
  readonly resumeCheckpoint: string | null
  /** Optional first-turn prompt — when present, spawn is an atomic round-trip. */
  readonly prompt: string | null
  /** Optional caller-supplied wall-clock cap; `null` means unbounded. */
  readonly timeoutMs: number | null
  /** Human-readable display name for fleet listing; null falls back to `name`. */
  readonly displayName: string | null
}

/**
 * Temporary compatibility carrier for migrated Claude verbs whose public
 * stdout/stderr contract is already pinned by conformance goldens. The
 * structured fields stay authoritative for engine-neutral verbs; CLI
 * formatters can return `tmResult` verbatim when it is present.
 */
export interface RawTmResult {
  readonly tmResult?: TmResult
}

export type SpawnResult =
  | ({ kind: 'spawned'; name: TeammateName; firstTurn: TurnResult | null } & RawTmResult)
  | ({ kind: 'already-exists'; existingEngine: EngineKind } & RawTmResult)
  | ({ kind: 'failed'; message: string } & RawTmResult)

// ─── Send / Wait ────────────────────────────────────────────────────────

export interface SendRequest {
  readonly name: TeammateName
  readonly prompt: string
  readonly timeoutMs: number | null
  readonly paneQuiet: boolean
}

export interface WaitRequest {
  readonly name: TeammateName
  /** A previous turn-id to recover from, when send/spawn aborted before reading. */
  readonly recoverFor: string | null
  readonly timeoutMs: number | null
  readonly fresh: boolean
  readonly paneQuiet: boolean
}

export type TurnResult =
  | ({
      kind: 'completed'
      text: string
      items: readonly InteractionItem[]
      context: ContextResult | null
    } & RawTmResult)
  | ({ kind: 'failed'; message: string; recoverable: boolean } & RawTmResult)
  | ({ kind: 'timed-out'; elapsedMs: number } & RawTmResult)
  | ({ kind: 'not-supported'; reason: string } & RawTmResult)
  | ({ kind: 'no-op'; reason: string } & RawTmResult)

// ─── Kill ───────────────────────────────────────────────────────────────

export interface KillRequest {
  readonly name: TeammateName
}

export type KillResult =
  | { kind: 'killed'; note?: string }
  | { kind: 'not-found' }
  | { kind: 'failed'; message: string }

// ─── Compact / Resume / Reload ──────────────────────────────────────────

export interface CompactRequest {
  readonly name: TeammateName
  readonly timeoutMs: number | null
}

export type CompactResult =
  | ({ kind: 'compacted' } & RawTmResult)
  | ({ kind: 'not-needed'; reason: string } & RawTmResult)
  | ({ kind: 'not-supported'; reason: string } & RawTmResult)
  | ({ kind: 'failed'; message: string } & RawTmResult)

export interface ResumeRequest {
  readonly name: TeammateName
  /** Physical repo path the teammate is bound to; `null` when unknown. */
  readonly repo: string | null
  /** Absolute working directory used by engines that relaunch a process. */
  readonly cwd: string | null
  /** Worktree slug under `.claude/worktrees/`; `null` for `--no-worktree`. */
  readonly worktreeSlug: string | null
  /** Engine-specific identifier (Claude sid / Codex thread id); null lets the engine auto-pick when supported. */
  readonly checkpoint: string | null
  /** Optional first-turn prompt after the resumed teammate is relaunched. */
  readonly prompt: string | null
  /** Optional display relabel for engines that expose one. */
  readonly displayName: string | null
}

export type ResumeResult =
  | ({ kind: 'resumed'; checkpoint: string | null } & RawTmResult)
  | ({ kind: 'not-found'; reason: string } & RawTmResult)
  | ({ kind: 'not-supported'; reason: string } & RawTmResult)
  | ({ kind: 'failed'; message: string } & RawTmResult)

export interface ReloadRequest {
  readonly name: TeammateName
}

export type ReloadResult =
  | ({ kind: 'reloaded' } & RawTmResult)
  | ({ kind: 'not-supported'; reason: string } & RawTmResult)
  | ({ kind: 'failed'; message: string } & RawTmResult)

// ─── Last / Ctx / History / Mem ────────────────────────────────────────

export interface LastRequest {
  readonly name: TeammateName
  readonly verbose: boolean
}

export interface ContextRequest {
  readonly name: TeammateName
  readonly windowOverride: '' | '200k' | '1m'
}

export type ContextResult =
  | ({ kind: 'usage'; tokensUsed: number; tokensTotal: number; pct: number } & RawTmResult)
  | ({ kind: 'not-supported'; reason: string } & RawTmResult)
  | ({ kind: 'failed'; message: string } & RawTmResult)

export interface HistoryRequest {
  readonly name: TeammateName
  /** Absolute working directory used by engines whose history is keyed by cwd. */
  readonly cwd: string | null
  /** `null` = list view; non-null = engine-specific detail selector. */
  readonly index: string | null
}

export type HistoryResult =
  | ({ kind: 'list'; turns: readonly HistoryTurn[]; entries?: readonly HistoryListEntry[] } & RawTmResult)
  | ({ kind: 'detail'; turn: HistoryTurn; items: readonly InteractionItem[] } & RawTmResult)
  | ({ kind: 'not-supported'; reason: string } & RawTmResult)
  | ({ kind: 'failed'; message: string } & RawTmResult)

export interface HistoryListEntry {
  readonly engine: EngineKind
  readonly id: string
  readonly mtimeMs: number
  readonly size: number
  readonly topic: string
  readonly active: boolean
}

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
  | ({ kind: 'text'; text: string } & RawTmResult)
  | ({ kind: 'not-found'; reason: string } & RawTmResult)
  | ({ kind: 'not-supported'; reason: string } & RawTmResult)
  | ({ kind: 'failed'; message: string } & RawTmResult)

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
  /** Physical repo path the teammate is bound to. */
  readonly repo: string
  /** Runtime working directory (worktree path or `repo`). */
  readonly cwd: string
  /** Worktree slug, or `null` for `--no-worktree`. */
  readonly worktreeSlug: string | null
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
