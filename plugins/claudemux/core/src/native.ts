/**
 * Native verb implementations — Phase B of the strangler migration.
 *
 * Phase A fronted every `tm` verb with a shell-out (`tm.ts`). Phase B replaces
 * those shell-outs with native TypeScript, one verb at a time, read-only verbs
 * first (`.agents/domains/mcp-native-orchestrator.md` §12). A migrated verb is
 * a `NativeVerb` in this module; `core.ts` runs it instead of shelling out.
 *
 * A `NativeVerb` returns a `TmResult` — the exact `{code, stdout, stderr}`
 * shape `runTm` returns — not a `CallToolResult`. That keeps `verbResult` (in
 * `core.ts`) the single result-shaping site, and it makes the migration's
 * correctness criterion literal: a native verb conforms iff its `TmResult`
 * equals what `tm <verb>` produces for the same inputs. `test/conformance.test.ts`
 * is that differential check, against the live `tm`.
 *
 * Migration is behavior-preserving: a native verb reproduces what `tm` does
 * today, bug for bug, down to the exact text of an error line. Fixing a `tm`
 * behavior is a separate change, never folded into the migration.
 *
 * Migrated so far: `ls`, `last`, `ctx`, `states`, `mem`, `history`, `status`,
 * `poll`, `kill`, `archive`, `reload`.
 *
 * `reload` is the one native verb that itself shells out to `tm`: it is sugar
 * over `tm send --no-wait`, and `send` is not yet migrated, so `reload` fans
 * out natively but delegates each teammate's send to a `tm send` subprocess.
 */

import {
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  busyMarkerFor,
  cwdFile,
  encodeProjectDir,
  lastFileFor,
  readyFile,
  sendAtFile,
  sidFile,
} from './paths'
import type { TmResult, TmRunOptions } from './tm'
import type { ColumnRunner } from './column'
import type { GrepRunner } from './grep'
import type { TmuxRunner } from './tmux'
import type { EngineRegistryView } from './engines/registry'
import {
  codexAsk,
  codexKill,
  codexListLines,
  codexSend,
  codexSpawn,
  codexStateRows,
  codexStatus,
  codexWait,
  isCodexTarget,
} from './engines/codex/verbs'
import { claudeCtxLine } from './engines/claude/ctx'
import { claudeLast } from './engines/claude/last'
import { claudeMem } from './engines/claude/mem'
import { TMUX_SESSION_PREFIX } from './engines/claude/persistence'
import {
  die,
  iterTeammates,
  requireSession,
  resolvePaneTarget,
  sessionField,
} from './engines/claude/tmux'
import { clearIdle, isDirectory, isRegularFile, resolveSid } from './engines/claude/idle'
import { isNonNegativeInteger, sleepMs } from './engines/claude/clock'
import { claudeCompact } from './engines/claude/compact'
import { claudeDoctor } from './engines/claude/doctor'
import { claudeHistory } from './engines/claude/history'
import { claudeReload } from './engines/claude/reload'
import { claudeResume } from './engines/claude/resume'
import { claudeSend, parseSendArgs } from './engines/claude/send'
import { claudeSpawn, parseSpawnArgs } from './engines/claude/spawn'
import { claudeWait, parseWaitArgs } from './engines/claude/wait'

/** Backwards-compat alias for the historic `SESSION_PREFIX` constant. */
const SESSION_PREFIX = TMUX_SESSION_PREFIX

/** Everything a native verb may need beyond its arguments; injectable for tests. */
export interface NativeEnv {
  /** Runs `tmux` — injected so a conformance fixture can supply a fake. */
  runTmux: TmuxRunner
  /** Aligns tab-separated rows via `column -t` — for table-rendering verbs. */
  runColumn: ColumnRunner
  /** Matches input against a regex via `grep -qE` — for the `poll` verb. */
  runGrep: GrepRunner
  /** The dispatcher directory — the parent of the sibling teammate repos. */
  dispatcherDir: string
  /** The `~/.claude/projects` directory that holds Claude Code transcripts. */
  projectsDir: string
  /** Production Engine registry for Phase 2 verbs; optional for legacy tests. */
  engines?: EngineRegistryView
}

/**
 * One natively-migrated verb. Same call shape as a `tm` shell-out and the
 * same `TmResult` return, so `core.ts` can swap one for the other and shape
 * the result identically.
 */
export type NativeVerb = (
  args: readonly string[],
  options: TmRunOptions | undefined,
  env: NativeEnv,
) => Promise<TmResult>

/**
 * `tm ls` — list running teammate tmux sessions.
 *
 * Runs `tmux ls` and keeps the lines whose session name starts with
 * `teammate-`. `tmux ls` exits non-zero when no server is running; `tm`
 * masks that (`tmux ls || true`) and so does this — only stdout is read, and
 * an empty result is the ordinary "no sessions" case, not an error.
 */
const ls: NativeVerb = async (_args, _options, env) => {
  // `tm ls` masks every `tmux` failure (`tmux ls 2>/dev/null || true`): a
  // non-zero exit — and a `tmux` that cannot be spawned at all — is just the
  // ordinary "no sessions" case. So only stdout is read, and a runner that
  // throws (missing binary) is caught and treated as empty output.
  let listing = ''
  try {
    listing = (await env.runTmux(['ls'])).stdout
  } catch {
    listing = ''
  }
  const rows = listing
    .split('\n')
    .filter((line) => sessionField(line).startsWith(SESSION_PREFIX))
  const codexRows = await codexListLines(env.engines?.get('codex'))
  const allRows = [...rows, ...codexRows]
  const text =
    allRows.length > 0
      ? `${allRows.join('\n')}\n`
      : "(no teammate sessions; use 'tm spawn <repo>')\n"
  return { code: 0, stdout: text, stderr: '' }
}

/**
 * `tm last` — reprint a teammate's last-turn reply.
 *
 * The body lives in `engines/claude/last.ts` (`claudeLast`); this is the
 * thin wrapper that the NATIVE_VERBS dispatch path still calls. The
 * structured result is rendered to a TmResult here so the wire format
 * stays byte-identical with the cli dispatch path that calls
 * `ClaudeEngine.last` directly.
 */
const last: NativeVerb = async (args) => {
  const repo = args[0] ?? ''
  if (repo.length === 0) return die('usage: tm last <repo>')
  const result = claudeLast(repo)
  if (result.kind === 'text') return { code: 0, stdout: result.text, stderr: '' }
  if (result.kind === 'failed') return die(result.message)
  return die(`unexpected last result: ${(result as { kind: string }).kind}`)
}


/** The running teammate repo names — `tm`'s `iter_repos` via `iterTeammates`. */
const iterRepos = iterTeammates

/** The outcome of parsing `ctx`'s arguments: a plan, or an early-exit result. */
type CtxArgs = { repos: string[]; windowOverride: string; all: boolean } | { error: TmResult }

/**
 * Parse `tm ctx`'s flags — `--all`, `--window <v>`, `--window=<v>` — mirroring
 * `cmd_ctx`'s loop. A bare `--window` with no value reproduces `tm`'s quirk: a
 * `shift 2` past the end of the arguments fails under `set -e`, so `tm` exits
 * 1 with no output at all.
 */
function parseCtxArgs(args: readonly string[]): CtxArgs {
  const repos: string[] = []
  let windowOverride = ''
  let all = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--all') {
      all = true
    } else if (arg === '--window') {
      if (i + 1 >= args.length) return { error: { code: 1, stdout: '', stderr: '' } }
      windowOverride = args[i + 1]!
      i++
    } else if (arg.startsWith('--window=')) {
      windowOverride = arg.slice('--window='.length)
    } else if (arg.startsWith('-')) {
      return { error: die(`tm ctx: unknown flag: ${arg}`) }
    } else {
      repos.push(arg)
    }
  }
  if (windowOverride !== '' && windowOverride !== '200k' && windowOverride !== '1m') {
    return { error: die('tm ctx: --window must be 200k or 1m') }
  }
  return { repos, windowOverride, all }
}

/**
 * `tm ctx` — report context-window usage for one or more teammates.
 *
 * Each teammate yields one line, or a `? (...)` diagnostic when its transcript
 * cannot be read; `--all` fans out across every running teammate. Migrating
 * the verb keeps the jsonl parse in the core rather than shelling out to `jq`.
 */
const ctx: NativeVerb = async (args, _options, env) => {
  const parsed = parseCtxArgs(args)
  if ('error' in parsed) return parsed.error

  const repos = [...parsed.repos]
  if (parsed.all) repos.push(...(await iterRepos(env.runTmux)))
  if (repos.length === 0) {
    return die('usage: tm ctx <repo> [<repo>...] | --all  [--window 200k|1m]')
  }

  const lines = repos.map((repo) => claudeCtxLine(repo, parsed.windowOverride, env))
  return { code: 0, stdout: `${lines.join('\n')}\n`, stderr: '' }
}

/** Format a second-count as a short relative age — `tm`'s `fmt_age`. */
function fmtAge(age: number): string {
  if (age < 60) return `${age}s`
  if (age < 3600) return `${Math.floor(age / 60)}m`
  if (age < 86400) return `${Math.floor(age / 3600)}h`
  return `${Math.floor(age / 86400)}d`
}

/**
 * The `PREVIEW` cell for one teammate — the first line of its `.last`, with
 * control characters stripped, truncated to 50 characters (code points, as
 * `tm`'s `perl -CSD substr` counts them). Empty after stripping, or the file
 * unreadable, → `(no first line)`.
 */
function lastPreview(lastFile: string): string {
  let content: string
  try {
    content = readFileSync(lastFile, 'utf8')
  } catch {
    return '(no first line)'
  }
  // Strip control characters (code point <= 0x1f), then take the first 50
  // characters — `tr -d` then `perl -CSD substr` in `tm`. Iterate code
  // points so the count matches perl's `-CSD` character count.
  const preview = [...(content.split('\n')[0] ?? '')]
    .filter((ch) => (ch.codePointAt(0) ?? 0) > 0x1f)
    .slice(0, 50)
    .join('')
  return preview.length > 0 ? preview : '(no first line)'
}

/** One `states` table row for a teammate: REPO, SID, BUSY, LAST, PREVIEW. */
function statesRow(repo: string, now: number): string[] {
  const sid = resolveSid(repo)
  const sidShort = sid === null ? '?' : sid.slice(0, 8)
  // `pane_busy`: a teammate is busy iff its `.busy` marker file exists.
  const busy = sid !== null && isRegularFile(busyMarkerFor(sid)) ? 'yes' : 'no'
  let last = '-'
  let preview = '-'
  if (sid !== null && sid.length > 0) {
    const lf = lastFileFor(sid)
    let stat: Stats | null
    try {
      stat = statSync(lf)
    } catch {
      stat = null
    }
    // `[[ -s "$lf" ]]` — present and non-empty.
    if (stat !== null && stat.size > 0) {
      const age = now - Math.floor(stat.mtimeMs / 1000)
      last = `${stat.size}B/${fmtAge(age)}`
      preview = lastPreview(lf)
    }
  }
  return [repo, sidShort, busy, last, preview]
}

/**
 * `tm states` — a one-line fleet snapshot of every teammate: its sid, whether
 * it is mid-turn, and the size / age / preview of its last reply.
 *
 * The per-teammate row logic is native; the table is aligned by piping the
 * tab-separated rows through `column -t`, exactly as `cmd_states` does.
 */
const states: NativeVerb = async (_args, _options, env) => {
  const repos = await iterRepos(env.runTmux)
  // `now` is sampled once, before the loop — `tm`'s `cmd_states` does the same.
  const now = Math.floor(Date.now() / 1000)
  const codexRows = await codexStateRows(now, env.engines?.get('codex'))
  if (repos.length === 0 && codexRows.length === 0) {
    return { code: 0, stdout: '(no teammate sessions)\n', stderr: '' }
  }
  const rows = [
    ['REPO', 'SID', 'BUSY', 'LAST', 'PREVIEW'],
    ...repos.map((repo) => statesRow(repo, now)),
    ...codexRows,
  ]
  // The `column` result *is* the verb's result — `tm`'s `cmd_states` likewise
  // ends in `| column`, so `column`'s exit code, stdout, and stderr are what
  // `tm states` produces.
  return env.runColumn(`${rows.map((row) => row.join('\t')).join('\n')}\n`)
}


/**
 * `tm mem` — print a sibling repo's auto-memory index.
 *
 * Reads the repo's `~/.claude/projects/<dir>/memory/MEMORY.md`. A repo that
 * never ran Claude Code — or whose project dir was pruned — has no such file;
 * that is a normal "no sibling memory" case, reported on stderr with exit 0
 * (not an error) so a dispatcher composing a spawn prompt can call `mem`
 * opportunistically. An empty `MEMORY.md` is still a file, so it prints as
 * empty output with exit 0 — `tm`'s `[[ -f ]]` then `cat`, reproduced.
 */
const mem: NativeVerb = async (args, _options, env) => {
  const repo = args[0] ?? ''
  if (repo.length === 0) return die('usage: tm mem <repo>')
  const result = claudeMem(repo, env)
  switch (result.kind) {
    case 'text':
      return { code: 0, stdout: result.text, stderr: '' }
    case 'failed':
      return die(result.message)
    case 'not-supported':
      return { code: 0, stdout: '', stderr: `${result.reason}\n` }
  }
}

/**
 * `tm history` — thin wrapper over `engines/claude/history.ts`. The
 * body now lives there together with the jsonl parser helpers; this
 * arm only routes the NATIVE_VERBS dispatch.
 */
const history: NativeVerb = async (args, _options, env) => claudeHistory(args, env)


/**
 * `tm status` — capture a teammate's live pane (a diagnostic verb).
 *
 * Resolves the session, then prints `tmux capture-pane` verbatim: that
 * capture's result *is* the verb's result, exactly as `cmd_status` ends in a
 * bare `capture-pane`. The `lines` argument bounds the scrollback `-S`.
 */
const status: NativeVerb = async (args, _options, env) => {
  const repo = args[0] ?? ''
  if (repo.length === 0) return die('usage: tm status <repo> [lines=80]')
  if (isCodexTarget(repo)) return codexStatus(repo, env.engines?.get('codex'))
  // `||`, not `??`: `tm`'s `${2:-80}` also defaults on an empty-string arg.
  const lines = args[1] || '80'

  const sessionMissing = await requireSession(repo, env.runTmux)
  if (sessionMissing !== null) return sessionMissing

  const pane = await resolvePaneTarget(repo, env.runTmux)
  if (pane === '') return die(`could not resolve pane target for ${repo}`)

  return env.runTmux(['capture-pane', '-t', pane, '-p', '-S', `-${lines}`])
}

/**
 * `tm poll` — block until a teammate's pane matches a regex, or a timeout
 * elapses (a diagnostic verb).
 *
 * The poll loop is native; the match itself delegates to the real `grep -E`,
 * the way `states` delegates alignment to `column`. `tm`'s `capture-pane |
 * grep -qE` runs under `set -o pipefail`, so a match needs both the capture
 * to succeed and `grep` to exit 0.
 */
const poll: NativeVerb = async (args, _options, env) => {
  const repo = args[0] ?? ''
  const pattern = args[1] ?? ''
  if (repo === '' || pattern === '') {
    return die('usage: tm poll <repo> <regex> [timeout=180]')
  }
  // `||`, not `??`: `tm`'s `${3:-180}` also defaults on an empty-string arg.
  const timeoutArg = args[2] || '180'

  const sessionMissing = await requireSession(repo, env.runTmux)
  if (sessionMissing !== null) return sessionMissing

  const pane = await resolvePaneTarget(repo, env.runTmux)
  if (pane === '') return die(`could not resolve pane target for ${repo}`)

  // `bashNum('3.5')` returns 0 silently; bash's `(( end = ... + 3.5 ))` dies
  // under `set -e` with no output. Match the silent-fail by validating with
  // the same guard `send` / `wait` / `compact` use for their `--timeout`.
  if (!isNonNegativeInteger(timeoutArg)) return { code: 1, stdout: '', stderr: '' }
  const end = Math.floor(Date.now() / 1000) + Number(timeoutArg)
  while (Math.floor(Date.now() / 1000) < end) {
    const capture = await env.runTmux(['capture-pane', '-t', pane, '-p', '-S', '-300'])
    if (capture.code === 0 && (await env.runGrep(pattern, capture.stdout)) === 0) {
      return { code: 0, stdout: `matched: ${pattern}\n`, stderr: '' }
    }
    await sleepMs(3000)
  }
  return {
    code: 1,
    stdout: '',
    stderr: `tm: timeout after ${timeoutArg}s waiting for /${pattern}/ in ${repo}\n`,
  }
}

/**
 * `tm kill` — tear a teammate down: clear its hook artifacts, remove its four
 * repo-keyed `/tmp` files, and kill its tmux session. Reports `killed:` when a
 * session was running, `not running:` when none was — `cmd_kill` reproduced.
 *
 * `tm kill` removes the `/tmp` files unconditionally (its `rm -f` no-ops on an
 * absent file), so the verb is the same whether or not the teammate was live.
 */
const kill: NativeVerb = async (args, _options, env) => {
  const repo = args[0] ?? ''
  if (repo.length === 0) return die('usage: tm kill <repo>')
  if (isCodexTarget(repo)) return codexKill(repo, { engine: env.engines?.get('codex') })
  const name = `${SESSION_PREFIX}${repo}`

  // A recorded sid means there are hook artifacts to clear first.
  const sid = resolveSid(repo)
  if (sid !== null) clearIdle(sid)

  for (const file of [sidFile(repo), sendAtFile(repo), readyFile(repo), cwdFile(repo)]) {
    rmSync(file, { force: true })
  }

  let running = false
  try {
    running = (await env.runTmux(['has-session', '-t', `=${name}`])).code === 0
  } catch {
    running = false
  }
  if (running) {
    await env.runTmux(['kill-session', '-t', `=${name}`])
    return { code: 0, stdout: `killed: ${repo} (tmux=${name})\n`, stderr: '' }
  }
  return { code: 0, stdout: `not running: ${repo} (tmux=${name})\n`, stderr: '' }
}

/**
 * The seed `dispatcher-tasks-archive.md` `tm archive` writes when the archive
 * file does not exist yet — `cmd_archive`'s `ARCHIVE_EOF` heredoc, verbatim.
 */
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

/** The current date as `YYYY-MM-DD` in local time — `tm`'s `date +%Y-%m-%d`. */
function fmtLocalDate(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Split a ledger file into its lines as `grep`/`sed` count them — a trailing
 * newline does not add an empty final line.
 */
function ledgerLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The outcome of parsing `tm archive`'s arguments: an `id`/`status`, or an early exit. */
type ArchiveArgs = { id: string; status: string } | { error: TmResult }

/**
 * Parse `tm archive`'s flags — one positional `id`, an optional `--status` /
 * `--status=` — mirroring `cmd_archive`'s loop. A bare trailing `--status`
 * reproduces `tm`'s quirk: the `shift 2` past the end fails under `set -e`, so
 * `tm` exits 1 with no output.
 */
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

/**
 * `tm archive` — move a finished task from the active dispatcher ledger to the
 * archive. It cuts the entry block out of `active-dispatcher-tasks.md`, copies
 * repo/branch/intent from it, stamps the close date and the outcome (read from
 * stdin), and prepends a compressed entry to `dispatcher-tasks-archive.md`,
 * creating that file from its template when it does not exist. `cmd_archive`
 * reproduced, including the grep-located block and the `[status]`-tag carry.
 */
const archive: NativeVerb = async (args, options, env) => {
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

  // The outcome is read from stdin so multi-word / URL text needs no quoting.
  const outcome = (options?.stdin ?? '').replace(/\n+$/, '')
  if (outcome.replace(/\s/g, '') === '') {
    return die(`outcome text required on stdin, e.g.:  echo '...' | tm archive ${id}`)
  }

  const activeContent = readFileSync(activePath, 'utf8')
  const activeLines = ledgerLines(activeContent)

  // Locate the entry block. The header carries a trailing status tag, so the
  // id is matched by prefix: `### <id>` then whitespace or end-of-line. `tm`
  // interpolates the id straight into the `grep -E` pattern; an id `grep`
  // cannot compile (a stray metacharacter) finds nothing, like `tm`'s.
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

  // The block runs from its header to the line before the next `### `/`## `
  // header, or to the last line (`wc -l`) when none follows.
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

  // Carry the header's `[tag]` as the status unless `--status` overrode it.
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

  // Prepend the entry to the archive — above its first `### ` entry, or after
  // the header block when it has none. The archive is seeded if it is absent.
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

  // Remove the original block from the active ledger.
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

/**
 * `tm reload` — fan `/reload-plugins` out to one, many, or all teammates.
 *
 * The verb is sugar over `tm send --no-wait <repo> --prompt /reload-plugins`.
 * Argument parsing and the repo fan-out are native; each teammate's send
 * dispatches into the native `send` handler in-process — no subprocess.
 *
 * `cmd_reload`'s `(failed — ...)` line and keep-iterating `rc` are dead code:
 * `cmd_send`'s `_send_keys` `die`s (`exit 1`) for a non-running teammate
 * rather than returning non-zero, which terminates `tm reload` outright. So
 * `reload` reproduces what `tm reload` *does* — stop at the first send that
 * exits non-zero, and propagate that exit code — not the unreachable intent.
 */
const reload: NativeVerb = async (args, _options, env) => claudeReload(args, env)

// --- doctor ---------------------------------------------------------------

/**
 * `tm`'s `cmd_doctor` — a read-only environment self-check. Sections fire
 * top-down: the `tm` executable, the dispatcher dir, tmux, the idle dir,
 * and the active teammate list. Soft-fails throughout (every probe is
 * guarded) and always exits 0; output is meant to be eyeballed, not parsed.
 *
 * The path the "tm executable" section reports is this module's own
 * `bin/tm` wrapper (`core/bin/tm`), not the bash `bin/tm`. Bash is the
 * stage-3 oracle; once stage 3c retires it, the Node CLI is the only `tm`
 * binary that exists.
 */
/**
 * `tm doctor` — thin wrapper over `engines/claude/doctor.ts`. The path
 * to `<plugin-root>/bin/tm` and the manifest is computed here because
 * `import.meta.url` of this `core/src/native.ts` is two directories
 * below the plugin root (same as the bundled `core/dist/cli.mjs`);
 * the engines/claude/doctor.ts module is two more levels deep, so its
 * own `import.meta.url` cannot do the math.
 */
const doctor: NativeVerb = async (args, _options, env) => {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const tmWrapper = join(moduleDir, '..', '..', 'bin', 'tm')
  const pluginJson = join(moduleDir, '..', '..', '.claude-plugin', 'plugin.json')
  return claudeDoctor(args, env, { tmWrapper, pluginJson })
}

// --- spawn ----------------------------------------------------------------

/**
 * `tm spawn` — codex fork on this layer, claude body in
 * `engines/claude/spawn.ts`. The codex branch is the only reason this
 * wrapper still parses the args here; once the dispatcher gains its
 * router (cli.ts dispatch flip) the codex fork moves out and this arm
 * disappears.
 */
const spawn: NativeVerb = async (args, _options, env) => {
  const repo = args[0] ?? ''
  if (repo.length === 0) {
    return die('usage: tm spawn <repo> [--task <slug>] [--prompt "..."] [--no-wait]')
  }
  const parsed = parseSpawnArgs(args.slice(1))
  if ('error' in parsed) return parsed.error
  const { engine, resumeSid, task, prompt, hasPrompt, noWait, timeout } = parsed
  if (engine === 'codex' || (engine === null && isCodexTarget(repo))) {
    if (resumeSid.length > 0) return die('tm spawn: --resume is not supported for codex teammates')
    if (task.length > 0) return die('tm spawn: --task is not supported for codex teammates')
    if (noWait) return die('tm spawn: --no-wait is not supported for codex teammates')
    if (timeout !== null && !isNonNegativeInteger(timeout)) {
      return die(`tm spawn: --timeout must be a non-negative integer (got: '${timeout}')`)
    }
    const repoPath = join(env.dispatcherDir, repo)
    const cwdPhys = isDirectory(repoPath) ? realpathSync(repoPath) : realpathSync(env.dispatcherDir)
    return codexSpawn(repo, {
      cwd: cwdPhys,
      prompt: hasPrompt ? prompt : null,
      timeoutSec: timeout === null ? null : Number(timeout),
      displayName: null,
      engine: env.engines?.get('codex'),
    })
  }
  return claudeSpawn(args, env)
}

// --- send -----------------------------------------------------------------

/**
 * `tm send` — codex fork on this layer, claude body in
 * `engines/claude/send.ts`. The codex branch is the only reason this
 * wrapper still parses the args here.
 */
const send: NativeVerb = async (args, _options, env) => {
  const parsed = parseSendArgs(args)
  if ('error' in parsed) return parsed.error
  const { repo, prompt, hasPrompt, noWait, paneQuiet, timeout } = parsed
  if (repo !== '' && isCodexTarget(repo)) {
    if (!hasPrompt) {
      return die(
        'tm send: missing --prompt. Usage: tm send <repo> --prompt "..." [--no-wait] ' +
          '[--pane-quiet] [--timeout N]',
      )
    }
    if (!isNonNegativeInteger(timeout)) {
      return die(`tm send: --timeout must be a non-negative integer (got: '${timeout}')`)
    }
    if (noWait) return die('tm send: --no-wait is not supported for codex teammates')
    if (paneQuiet) return die('tm send: --pane-quiet is not supported for codex teammates')
    return codexSend(repo, prompt, {
      timeoutSec: Number(timeout),
      engine: env.engines?.get('codex'),
    })
  }
  return claudeSend(args, env)
}

// --- wait -----------------------------------------------------------------

/**
 * `tm wait` — codex fork on this layer, claude body in
 * `engines/claude/wait.ts`.
 */
const wait: NativeVerb = async (args, _options, env) => {
  const parsed = parseWaitArgs(args)
  if ('error' in parsed) return parsed.error
  const { repo, timeout, fresh, paneQuiet } = parsed
  if (repo !== '' && isCodexTarget(repo)) {
    if (!isNonNegativeInteger(timeout)) {
      return die(`tm wait: --timeout must be a non-negative integer (got: '${timeout}')`)
    }
    if (fresh) return die('tm wait: --fresh is not supported for codex teammates')
    if (paneQuiet) return die('tm wait: --pane-quiet is not supported for codex teammates')
    return codexWait(repo, { timeoutSec: Number(timeout), engine: env.engines?.get('codex') })
  }
  return claudeWait(args, env)
}

// --- compact --------------------------------------------------------------

/**
 * `tm compact` — pure claude verb, no codex fork. Thin wrapper over
 * `engines/claude/compact.ts`.
 */
const compact: NativeVerb = async (args, _options, env) => claudeCompact(args, env)

// --- resume ---------------------------------------------------------------

/**
 * `tm resume` — pure claude verb, no codex fork. Thin wrapper over
 * `engines/claude/resume.ts`.
 */
const resume: NativeVerb = async (args, _options, env) => claudeResume(args, env)

/** Every natively-migrated verb, keyed by verb name. */
/**
 * `tm ask "<prompt>"` — borrow an idle named codex teammate, run one turn
 * on a fresh thread, return the teammate. The "pool" is the spawned
 * `codex-<n>` set; this verb does not name a teammate. Always routes
 * into the codex driver, never into the tmux path.
 */
const ask: NativeVerb = async (args, _options, _env) => {
  if (args.length === 0) {
    return die('usage: tm ask "<prompt>"')
  }
  if (args.length > 1) {
    return die(
      `tm ask: takes exactly one positional argument (the prompt) — got ${args.length}`,
    )
  }
  return codexAsk(args[0] ?? '')
}

export const NATIVE_VERBS: Readonly<Record<string, NativeVerb>> = {
  ls,
  last,
  ctx,
  states,
  mem,
  history,
  status,
  poll,
  kill,
  archive,
  reload,
  doctor,
  spawn,
  send,
  wait,
  compact,
  resume,
  ask,
}

/** Whether `core.ts` should run this verb natively rather than shelling out. */
export function isNativeVerb(name: string): boolean {
  return Object.hasOwn(NATIVE_VERBS, name)
}
