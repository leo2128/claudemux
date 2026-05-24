/**
 * The per-invocation environment the CLI hands to each verb dispatcher.
 *
 * Lives in its own module so verb modules and the dispatcher share a
 * single interface without re-importing from each other; the historic
 * `NATIVE_VERBS` table that owned this shape is gone, but the shape
 * itself is still useful as a thin adapter layer.
 */

import type { ColumnRunner } from './column'
import type { GrepRunner } from './grep'
import type { TmuxRunner } from './tmux'
import type { EngineRegistryView } from './engines/registry'

/** Everything a verb handler may need beyond its arguments; injectable for tests. */
export interface NativeEnv {
  /** Runs `tmux` — injected so a conformance fixture can supply a fake. */
  readonly runTmux: TmuxRunner
  /** Aligns tab-separated rows via `column -t` — for table-rendering verbs. */
  readonly runColumn: ColumnRunner
  /** Matches input against a regex via `grep -qE` — for the `poll` verb. */
  readonly runGrep: GrepRunner
  /** The dispatcher directory — the parent of the sibling teammate repos. */
  readonly dispatcherDir: string
  /** The `~/.claude/projects` directory that holds Claude Code transcripts. */
  readonly projectsDir: string
  /** Production Engine registry; optional for legacy tests. */
  readonly engines?: EngineRegistryView
}
