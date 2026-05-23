/**
 * Codex teammate persistence.
 *
 * Decision 0024 splits teammate state into the base JSON
 * `/tmp/teammate-<name>.json` and engine-private extension files. Codex owns
 * the daemon registry directory under `/tmp/teammate-codex/<name>/`; hooks do
 * not write any of these files.
 */

import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

import { TeammateRecord } from '../teammate-record'
import type { EngineKind, TeammateName } from '../types'
import type { TeammateRecordJson } from '../teammate-record'

export interface CodexTeammateExtension {
  root: string
  pid: string
  socket: string
  thread: string
  startedAt: string
  lastSeen: string
  stdoutLog: string
  stderrLog: string
  meta: string
  lock: string
}

export interface CodexMeta {
  readonly schema: 1
  readonly name: TeammateName
  readonly cwd: string
  readonly displayName: string | null
  readonly spawnedAt: number
}

export function codexRegistryRoot(): string {
  return process.env['CLAUDEMUX_CODEX_REGISTRY_ROOT'] || '/tmp/teammate-codex'
}

export function codexTeammateDir(name: TeammateName): string {
  return join(codexRegistryRoot(), name)
}

export function codexSocketPath(name: TeammateName): string {
  return join(codexTeammateDir(name), 'socket')
}

export function codexPidFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'pid')
}

export function codexStartedAtFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'started-at')
}

export function codexThreadFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'thread')
}

export function codexLastSeenFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'last-seen')
}

export function codexStdoutLogFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'stdout.log')
}

export function codexStderrLogFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'stderr.log')
}

export function codexMetaFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'meta.json')
}

export function codexBorrowLockFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'lock')
}

export function codexExtension(name: TeammateName): CodexTeammateExtension {
  const root = codexTeammateDir(name)
  return {
    root,
    pid: codexPidFile(name),
    socket: codexSocketPath(name),
    thread: codexThreadFile(name),
    startedAt: codexStartedAtFile(name),
    lastSeen: codexLastSeenFile(name),
    stdoutLog: codexStdoutLogFile(name),
    stderrLog: codexStderrLogFile(name),
    meta: codexMetaFile(name),
    lock: codexBorrowLockFile(name),
  }
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, content, { mode: 0o600 })
  renameSync(tmp, path)
}

export function readBaseRecord(name: TeammateName): TeammateRecordJson | null {
  try {
    const parsed = JSON.parse(readFileSync(TeammateRecord.markerPath(name), 'utf8')) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { schema?: unknown }).schema === 1 &&
      typeof (parsed as { name?: unknown }).name === 'string' &&
      ((parsed as { engine?: unknown }).engine === 'claude' ||
        (parsed as { engine?: unknown }).engine === 'codex') &&
      typeof (parsed as { cwd?: unknown }).cwd === 'string' &&
      typeof (parsed as { createdAt?: unknown }).createdAt === 'number'
    ) {
      const displayName = (parsed as { displayName?: unknown }).displayName
      return {
        schema: 1,
        name: (parsed as { name: TeammateName }).name,
        engine: (parsed as { engine: EngineKind }).engine,
        cwd: (parsed as { cwd: string }).cwd,
        createdAt: (parsed as { createdAt: number }).createdAt,
        displayName: typeof displayName === 'string' ? displayName : null,
      }
    }
    return null
  } catch {
    return null
  }
}

export function writeBaseRecord(record: TeammateRecord): void {
  atomicWrite(
    TeammateRecord.markerPath(record.name),
    `${JSON.stringify(record.toJson(), null, 2)}\n`,
  )
}

export function removeBaseRecord(name: TeammateName): void {
  rmSync(TeammateRecord.markerPath(name), { force: true })
}

export function readCodexMeta(name: TeammateName): CodexMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(codexMetaFile(name), 'utf8')) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { schema?: unknown }).schema === 1 &&
      typeof (parsed as { name?: unknown }).name === 'string' &&
      typeof (parsed as { cwd?: unknown }).cwd === 'string' &&
      typeof (parsed as { spawnedAt?: unknown }).spawnedAt === 'number'
    ) {
      const displayName = (parsed as { displayName?: unknown }).displayName
      return {
        schema: 1,
        name: (parsed as { name: TeammateName }).name,
        cwd: (parsed as { cwd: string }).cwd,
        displayName: typeof displayName === 'string' ? displayName : null,
        spawnedAt: (parsed as { spawnedAt: number }).spawnedAt,
      }
    }
    return null
  } catch {
    return null
  }
}

export class CodexTeammateRecord extends TeammateRecord {
  readonly engine: EngineKind = 'codex'

  constructor(args: {
    name: TeammateName
    cwd: string
    createdAt: number
    displayName: string | null
  }) {
    super(args)
  }

  extension(): CodexTeammateExtension {
    return codexExtension(this.name)
  }

  override engineExtensionFiles(): readonly string[] {
    const ext = this.extension()
    return [
      ext.pid,
      ext.socket,
      ext.thread,
      ext.startedAt,
      ext.lastSeen,
      ext.stdoutLog,
      ext.stderrLog,
      ext.meta,
      ext.lock,
    ]
  }
}
