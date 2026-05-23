/**
 * `tm archive <id>` — move a finished task from the dispatcher's active
 * ledger to its archive. Decision 0024 §"Target shape" puts `archive`
 * in `verbs/` because it touches no teammate process; it edits two
 * dispatcher-local markdown files under
 * `~/.claude/projects/<encoded-dispatcher-dir>/memory/`. No engine is
 * consulted.
 *
 * The verb cuts the `### <id>` block out of `active-dispatcher-tasks.md`,
 * carries `repo / branch / intent` lines from the cut block, stamps the
 * close date and the outcome read from stdin, and prepends a compressed
 * entry to `dispatcher-tasks-archive.md` (seeded from `ARCHIVE_TEMPLATE`
 * when absent). The behavior is byte-identical to the legacy
 * `NATIVE_VERBS.archive` it replaces.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { encodeProjectDir } from '../persistence/project-dir'
import type { TmResult } from '../tm'

/** The seed `dispatcher-tasks-archive.md` written when the archive file does not exist yet. */
const ARCHIVE_TEMPLATE = `${[
  '---',
  'name: dispatcher-tasks-archive',
  'description: "On-demand archive of closed dispatcher tasks, compressed to outcome + artifacts. NOT a boot read — only consult when looking up past task history. Live in-flight tasks live in active-dispatcher-tasks.md."',
  'metadata:',
  '  node_type: memory',
  '  type: project',
  '---',
  '',
  '# Dispatcher task archive',
  '',
  'Closed tasks moved here from `active-dispatcher-tasks.md`, compressed to a',
  'pointer + conclusion (not a knowledge base). Newest on top. Reusable analysis',
  'that outlives a task should be promoted to its own memory file, not kept here.',
  '',
  '<!-- split by month (dispatcher-tasks-archive-YYYY-MM.md) if this file grows past a few hundred entries -->',
].join('\n')}\n`

/** `tm`'s `die`: one `tm: <message>` line on stderr, exit 1. */
function die(message: string): TmResult {
  return { code: 1, stdout: '', stderr: `tm: ${message}\n` }
}

/** Whether a path exists and is a regular file. */
function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The current date as `YYYY-MM-DD` in local time. */
function fmtLocalDate(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Split a ledger file into lines; a trailing newline does not add an empty final line. */
function ledgerLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

type ArchiveArgs = { id: string; status: string } | { error: TmResult }

function parseArchiveArgs(args: readonly string[]): ArchiveArgs {
  let id = ''
  let status = ''
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--status') {
      if (i + 1 >= args.length) return { error: { code: 1, stdout: '', stderr: '' } }
      status = args[i + 1]!
      i++
    } else if (arg.startsWith('--status=')) {
      status = arg.slice('--status='.length)
    } else if (arg.startsWith('-')) {
      return { error: die(`tm archive: unknown flag: ${arg}`) }
    } else if (id === '') {
      id = arg
    } else {
      return { error: die(`tm archive: unexpected arg: ${arg}`) }
    }
  }
  return { id, status }
}

export interface ArchiveEnv {
  /** The dispatcher directory — `~/.claude/projects/<encoded(this)>` holds the ledger. */
  readonly dispatcherDir: string
  /** The Claude Code projects root. */
  readonly projectsDir: string
}

/** `tm archive` body. The stdin outcome is required; see the usage line for the form. */
export async function archiveVerb(
  args: readonly string[],
  stdin: string | undefined,
  env: ArchiveEnv,
): Promise<TmResult> {
  const parsed = parseArchiveArgs(args)
  if ('error' in parsed) return parsed.error
  const { id } = parsed
  if (id === '') {
    return die("usage: tm archive <id> [--status '<tag>']   (outcome text on stdin)")
  }

  const memoryDir = join(env.projectsDir, encodeProjectDir(env.dispatcherDir), 'memory')
  const activePath = join(memoryDir, 'active-dispatcher-tasks.md')
  const archivePath = join(memoryDir, 'dispatcher-tasks-archive.md')
  if (!isRegularFile(activePath)) return die(`no active ledger at ${activePath}`)

  const outcome = (stdin ?? '').replace(/\n+$/, '')
  if (outcome.replace(/\s/g, '') === '') {
    return die(`outcome text required on stdin, e.g.:  echo '...' | tm archive ${id}`)
  }

  const activeContent = readFileSync(activePath, 'utf8')
  const activeLines = ledgerLines(activeContent)

  let headerRe: RegExp
  try {
    headerRe = new RegExp(`^### ${id}(\\s|$)`)
  } catch {
    headerRe = /(?!)/
  }
  const headerLines = activeLines
    .map((line, index) => (headerRe.test(line) ? index + 1 : 0))
    .filter((lineNo) => lineNo > 0)
  if (headerLines.length === 0) {
    const available = activeLines
      .map((line) => /^### [^ ]+/.exec(line)?.[0])
      .filter((match): match is string => match != null)
      .map((match) => match.slice('### '.length))
      .join(' ')
    return die(`id not found in active ledger: ${id}\n  available: ${available}`)
  }
  if (headerLines.length !== 1) {
    return die(`id matches ${headerLines.length} entries in active ledger: ${id}`)
  }

  const start = headerLines[0]!
  const total = (activeContent.match(/\n/g) ?? []).length
  let end = total
  for (let index = start; index < activeLines.length; index++) {
    if (/^(### |## )/.test(activeLines[index]!)) {
      end = index
      break
    }
  }
  const blockLines = activeLines.slice(start - 1, end)

  let status = parsed.status
  if (status === '') {
    const tag = /\[(.+)\]\s*$/.exec(blockLines[0] ?? '')
    status = tag ? tag[1]! : 'done'
  }

  const field = (name: string): string => {
    const line = blockLines.find((candidate) => candidate.startsWith(`- ${name}:`))
    if (line === undefined) return '(unknown)'
    const value = line.slice(`- ${name}:`.length).replace(/^\s*/, '')
    return value === '' ? '(unknown)' : value
  }
  const entry =
    `### ${id}  [${status}]\n` +
    `- repo/branch: ${field('repo')} / ${field('branch')}\n` +
    `- intent: ${field('intent')}\n` +
    `- outcome: ${outcome}\n` +
    `- closed: ${fmtLocalDate()}`

  const archiveContent = isRegularFile(archivePath)
    ? readFileSync(archivePath, 'utf8')
    : ARCHIVE_TEMPLATE
  const archiveLines = ledgerLines(archiveContent)
  let firstEntry = 0
  for (let index = 0; index < archiveLines.length; index++) {
    if (archiveLines[index]!.startsWith('### ')) {
      firstEntry = index + 1
      break
    }
  }
  let newArchive: string
  if (firstEntry > 0) {
    const head =
      firstEntry > 1 ? `${archiveLines.slice(0, firstEntry - 1).join('\n')}\n` : ''
    const tail = `${archiveLines.slice(firstEntry - 1).join('\n')}\n`
    newArchive = `${head}${entry}\n\n${tail}`
  } else {
    newArchive = `${archiveContent}\n${entry}\n`
  }

  const remaining = [...activeLines.slice(0, start - 1), ...activeLines.slice(end)]
  const newActive = remaining.length > 0 ? `${remaining.join('\n')}\n` : ''

  writeFileSync(archivePath, newArchive)
  writeFileSync(activePath, newActive)
  return {
    code: 0,
    stdout:
      `archived ${id}  [${status}] -> dispatcher-tasks-archive.md  ` +
      '(removed from active ledger)\n',
    stderr: '',
  }
}
