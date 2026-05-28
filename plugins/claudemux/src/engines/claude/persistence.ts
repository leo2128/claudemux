/**
 * ClaudeTeammateRecord.
 *
 * The base `/tmp/teammate-<name>.json` is owned by
 * `persistence/identity-store.ts`; the Claude extension path builders and
 * tmux session-name encoding live in `persistence/paths.ts`.
 */

import { TeammateRecord } from '../teammate-record'
import type { EngineKind, TeammateName } from '../types'
import { claudeExtensionFor, tmuxSessionName, type ClaudeTeammateExtension } from '../../persistence/paths'

export class ClaudeTeammateRecord extends TeammateRecord {
  readonly engine: EngineKind = 'claude'

  constructor(args: {
    name: TeammateName
    repo: string
    cwd: string
    worktreeSlug: string | null
    createdAt: number
    displayName: string | null
  }) {
    super(args)
  }

  /** The tmux session name this teammate is launched as. */
  tmuxSession(): string {
    return tmuxSessionName(this.name)
  }

  /** The Claude-engine extension paths for this teammate. */
  extension(): ClaudeTeammateExtension {
    return claudeExtensionFor(this.name)
  }

  override engineExtensionFiles(): readonly string[] {
    const ext = this.extension()
    return [ext.cwd, ext.sid, ext.ready, ext.sendAt]
  }
}
