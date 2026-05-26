/**
 * Codex teammate persistence.
 *
 * Decision multi-engine-tui-architecture splits teammate state into the base JSON
 * `/tmp/teammate-<name>.json` and engine-private extension files. Codex owns
 * the daemon registry directory under `/tmp/teammate-codex/<name>/`; hooks do
 * not write any of these files.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { TeammateRecord } from '../teammate-record'
import type { EngineKind, TeammateName } from '../types'
import type { TeammateRecordJson } from '../teammate-record'
import { validateTeammateName } from '../../identity/name'
import {
  read as readIdentity,
  remove as removeIdentity,
  reserve as reserveIdentity,
  write as writeIdentity,
  type ReserveResult,
} from '../../persistence/identity-store'

export interface CodexTeammateExtension {
  root: string
  pid: string
  socket: string
  thread: string
  startedAt: string
  lastSeen: string
  stdoutLog: string
  stderrLog: string
  ipcBridgePid: string
  ipcBridgeStdoutLog: string
  ipcBridgeStderrLog: string
  meta: string
  lock: string
  lastTurn: string
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

function assertValidCodexName(name: TeammateName): void {
  const validation = validateTeammateName(name)
  if (validation.kind !== 'ok') {
    throw new Error(`invalid codex teammate name '${name}': ${validation.reason}`)
  }
}

export function codexTeammateDir(name: TeammateName): string {
  assertValidCodexName(name)
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

export function codexIpcBridgePidFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'ipc-bridge.pid')
}

export function codexIpcBridgeStdoutLogFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'ipc-bridge.stdout.log')
}

export function codexIpcBridgeStderrLogFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'ipc-bridge.stderr.log')
}

export function codexMetaFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'meta.json')
}

export function codexBorrowLockFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'lock')
}

export function codexLastTurnFile(name: TeammateName): string {
  return join(codexTeammateDir(name), 'last-turn.json')
}

export function writeCodexLastTurn(name: TeammateName, json: string): void {
  const path = codexLastTurnFile(name)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, json)
  renameSync(tmp, path)
}

export function readCodexLastTurn(name: TeammateName): string | null {
  try {
    return readFileSync(codexLastTurnFile(name), 'utf8')
  } catch {
    return null
  }
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
    ipcBridgePid: codexIpcBridgePidFile(name),
    ipcBridgeStdoutLog: codexIpcBridgeStdoutLogFile(name),
    ipcBridgeStderrLog: codexIpcBridgeStderrLogFile(name),
    meta: codexMetaFile(name),
    lock: codexBorrowLockFile(name),
    lastTurn: codexLastTurnFile(name),
  }
}

export function readBaseRecord(name: TeammateName): TeammateRecordJson | null {
  if (validateTeammateName(name).kind !== 'ok') return null
  return readIdentity(name)
}

export function reserveBaseRecord(record: TeammateRecord): ReserveResult {
  assertValidCodexName(record.name)
  return reserveIdentity(record.toJson())
}

export function writeBaseRecord(record: TeammateRecord): void {
  assertValidCodexName(record.name)
  writeIdentity(record.toJson())
}

export function removeBaseRecord(name: TeammateName): void {
  if (validateTeammateName(name).kind !== 'ok') return
  removeIdentity(name)
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
      ext.ipcBridgePid,
      ext.ipcBridgeStdoutLog,
      ext.ipcBridgeStderrLog,
      ext.meta,
      ext.lock,
      ext.lastTurn,
    ]
  }
}
