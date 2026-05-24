/**
 * Verb-layer formatting helpers — turn structured engine results into
 * the `TmResult` (`{code, stdout, stderr}`) shape the CLI dispatcher
 * emits. Decision 0024 §"Verb is the abstraction" makes the verb own
 * exit codes and formatting; engines never decide either.
 *
 * Phase 1 lands minimal formatters good enough for the verb skeletons
 * to compile and produce a sensible CLI surface for the
 * "no engine registered" / "teammate not found" / "not supported"
 * cases. Phase 2's `presentation/format-*.ts` modules will replace
 * these as the rich formatting layer.
 */

import type {
  CompactResult,
  ContextResult,
  HistoryResult,
  KillResult,
  RawTmResult,
  ReloadResult,
  ResumeResult,
  TeammateListing,
  TeammateName,
  TeammateStatus,
  TextResult,
  TurnResult,
} from '../engines/types'
import type { TmResult } from '../tm'

function rawTmResult(result: RawTmResult): TmResult | null {
  return result.tmResult ?? null
}

/**
 * The "no teammate by this name" verb outcome. Exit code 1 follows the
 * convention every existing `die`-shaped verb uses today.
 */
export function teammateNotFound(name: TeammateName): TmResult {
  return { code: 1, stdout: '', stderr: `tm: no such teammate: ${name}\n` }
}

/**
 * The "no engine for this kind is registered in this process" verb
 * outcome. Surfaces a missing Phase 2 wiring loudly rather than
 * silently dispatching to nothing.
 */
export function noEngineRegistered(): TmResult {
  return {
    code: 1,
    stdout: '',
    stderr: 'tm: no engine registered in this process (Phase 2 wiring pending)\n',
  }
}

export function formatListing(rows: readonly TeammateListing[]): TmResult {
  if (rows.length === 0) {
    // Legacy `tm ls` printed a one-line "use spawn" pointer when the fleet
    // was empty; the cli path keeps that affordance so an empty `tm ls`
    // is informative rather than silent.
    return { code: 0, stdout: "(no teammate sessions; use 'tm spawn <repo>')\n", stderr: '' }
  }
  const lines = rows.map((r) => `${r.name}\t${r.engine}\t${r.state}\t${r.cwd}`)
  return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
}

export function formatStatus(status: TeammateStatus): TmResult {
  switch (status.kind) {
    case 'present': {
      // Phase 2a-1: the verb prints the captured pane text — same as the
      // legacy `tm status` did via `tmux capture-pane`. Phase 2a-2 may
      // prepend a structured header once the dispatcher consumers are
      // aware of the format change.
      return { code: 0, stdout: status.pane ?? '', stderr: '' }
    }
    case 'not-found':
      return { code: 1, stdout: '', stderr: 'tm: status: not found\n' }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: status: ${status.message}\n` }
  }
}

export function formatKill(name: TeammateName, result: KillResult): TmResult {
  switch (result.kind) {
    case 'killed':
      return { code: 0, stdout: `killed: ${name}\n`, stderr: '' }
    case 'not-found':
      return { code: 0, stdout: `not running: ${name}\n`, stderr: '' }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: kill: ${result.message}\n` }
  }
}

export function formatTurn(turn: TurnResult): TmResult {
  const raw = rawTmResult(turn)
  if (raw !== null) return raw
  switch (turn.kind) {
    case 'completed':
      return { code: 0, stdout: turn.text.endsWith('\n') ? turn.text : `${turn.text}\n`, stderr: '' }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: turn failed: ${turn.message}\n` }
    case 'timed-out':
      return { code: 1, stdout: '', stderr: `tm: turn timed out after ${turn.elapsedMs}ms\n` }
    case 'not-supported':
      return { code: 0, stdout: '', stderr: `  not supported: ${turn.reason}\n` }
    case 'no-op':
      return { code: 0, stdout: '', stderr: `  no-op: ${turn.reason}\n` }
  }
}

export function formatCompact(result: CompactResult): TmResult {
  const raw = rawTmResult(result)
  if (raw !== null) return raw
  switch (result.kind) {
    case 'compacted':
      return { code: 0, stdout: 'compacted\n', stderr: '' }
    case 'not-needed':
      return { code: 0, stdout: '', stderr: `  not needed: ${result.reason}\n` }
    case 'not-supported':
      return { code: 0, stdout: '', stderr: `  not supported: ${result.reason}\n` }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: compact: ${result.message}\n` }
  }
}

export function formatHistory(result: HistoryResult): TmResult {
  const raw = rawTmResult(result)
  if (raw !== null) return raw
  switch (result.kind) {
    case 'list': {
      const lines = result.turns.map((t) => `#${t.index}\t${t.summary}`)
      return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
    }
    case 'detail':
      return { code: 0, stdout: `#${result.turn.index}\t${result.turn.summary}\n`, stderr: '' }
    case 'not-supported':
      return { code: 0, stdout: '', stderr: `  not supported: ${result.reason}\n` }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: history: ${result.message}\n` }
  }
}

export function formatText(label: string, result: TextResult): TmResult {
  const raw = rawTmResult(result)
  if (raw !== null) return raw
  switch (result.kind) {
    case 'text':
      return { code: 0, stdout: result.text.endsWith('\n') ? result.text : `${result.text}\n`, stderr: '' }
    case 'not-supported':
      return { code: 0, stdout: '', stderr: `  not supported: ${result.reason}\n` }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: ${label}: ${result.message}\n` }
  }
}

export function formatContext(result: ContextResult): TmResult {
  const raw = rawTmResult(result)
  if (raw !== null) return raw
  switch (result.kind) {
    case 'usage':
      return {
        code: 0,
        stdout: `${result.tokensUsed} tokens · ${result.pct}% of ${result.tokensTotal}\n`,
        stderr: '',
      }
    case 'not-supported':
      return { code: 0, stdout: '', stderr: `  not supported: ${result.reason}\n` }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: ctx: ${result.message}\n` }
  }
}

export function formatResume(result: ResumeResult): TmResult {
  const raw = rawTmResult(result)
  if (raw !== null) return raw
  switch (result.kind) {
    case 'resumed':
      return { code: 0, stdout: `resumed: ${result.checkpoint ?? ''}\n`, stderr: '' }
    case 'not-found':
      return { code: 1, stdout: '', stderr: `tm: resume: ${result.reason}\n` }
    case 'not-supported':
      return { code: 0, stdout: '', stderr: `  not supported: ${result.reason}\n` }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: resume: ${result.message}\n` }
  }
}

export function formatReload(result: ReloadResult): TmResult {
  const raw = rawTmResult(result)
  if (raw !== null) return raw
  switch (result.kind) {
    case 'reloaded':
      return { code: 0, stdout: 'reloaded\n', stderr: '' }
    case 'not-supported':
      return { code: 0, stdout: '', stderr: `  not supported: ${result.reason}\n` }
    case 'failed':
      return { code: 1, stdout: '', stderr: `tm: reload: ${result.message}\n` }
  }
}
