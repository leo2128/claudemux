#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const coreDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const allowed = new Set([
  'exports|src/engines/claude/clock.ts|fmtLocalDate',
  'exports|src/engines/codex/verbs.ts|codexListLines',
  'exports|src/engines/codex/verbs.ts|codexStatus',
  'exports|src/persistence/atomic-file.ts|exists',
  'exports|src/verbs/format.ts|formatText',
  'types|src/tm.ts|TmRunOptions',
])

const result = spawnSync(
  'knip',
  ['--reporter', 'json', '--no-exit-code', '--no-progress'],
  {
    cwd: coreDir,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${resolve(coreDir, 'node_modules/.bin')}${delimiter}${process.env.PATH ?? ''}`,
    },
  },
)

if (result.error) {
  console.error(`dead-code lint: failed to run knip: ${result.error.message}`)
  process.exit(1)
}

if (result.status !== 0) {
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  console.error(`dead-code lint: knip exited with status ${result.status}`)
  process.exit(result.status ?? 1)
}

let report
try {
  report = JSON.parse(result.stdout)
} catch (err) {
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  console.error(`dead-code lint: failed to parse knip JSON: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const foundByKey = new Map()

function recordIssue(type, file, name) {
  const key = `${type}|${file}|${name}`
  if (!foundByKey.has(key)) {
    foundByKey.set(key, { type, file, name })
  }
}

for (const file of report.files ?? []) {
  recordIssue('files', file, '<file>')
}

for (const issue of report.issues ?? []) {
  for (const type of ['exports', 'types']) {
    for (const item of issue[type] ?? []) {
      recordIssue(type, issue.file, item.name)
    }
  }
}

const found = [...foundByKey.values()]
const newIssues = found.filter((issue) => !allowed.has(`${issue.type}|${issue.file}|${issue.name}`))
const missingBaseline = [...allowed].filter((key) => !foundByKey.has(key))
const remainingBaseline = allowed.size - missingBaseline.length

function renderKey(key) {
  const [type, file, name] = key.split('|')
  return `- ${type}: ${file} ${name}`
}

if (newIssues.length > 0) {
  console.error('dead-code lint: new issues detected outside the baseline:')
  for (const issue of newIssues) {
    console.error(`- ${issue.type}: ${issue.file} ${issue.name}`)
  }
  console.error(`dead-code lint: ${remainingBaseline}/${allowed.size} baseline issues still present.`)
  if (missingBaseline.length > 0) {
    console.error('dead-code lint: baseline issues cleared in this tree:')
    for (const key of missingBaseline) console.error(renderKey(key))
  }
  process.exit(1)
}

console.log(
  `dead-code lint: no new issues; ${remainingBaseline}/${allowed.size} baseline issues still present` +
    (missingBaseline.length > 0 ? ` (${missingBaseline.length} cleared)` : '') +
    '.',
)
if (missingBaseline.length > 0) {
  console.log('dead-code lint: baseline issues cleared in this tree:')
  for (const key of missingBaseline) console.log(renderKey(key))
}
