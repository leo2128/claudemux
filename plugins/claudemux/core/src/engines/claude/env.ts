/**
 * The environment a Claude-engine verb body needs at runtime. A subset
 * of `NativeEnv` — only the fields the Claude bodies touch — so a
 * future codex teammate registry change does not ripple through every
 * verb module.
 */

import type { ColumnRunner } from '../../column'
import type { TmuxRunner } from '../../tmux'

export interface ClaudeVerbEnv {
  readonly runTmux: TmuxRunner
  readonly runColumn: ColumnRunner
  readonly dispatcherDir: string
  readonly projectsDir: string
}
