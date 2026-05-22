/**
 * The orchestration core: it turns the `tm` verb set into MCP tools and keeps
 * the teammate registry in step with the mutating verbs.
 *
 * Phase A of the strangler migration: every verb tool shells out to the
 * unmodified `tm` (see `tm.ts`). The core adds exactly two things on top of
 * that pass-through — it maintains the teammate registry around
 * `spawn`/`resume`/`kill`, and it exposes the registry through one
 * core-native `teammates` tool. No verb logic is reimplemented here; that is
 * Phase B, one verb at a time.
 *
 * The core is transport-agnostic: it produces a tool list and a `handleTool`
 * function. `server.ts` is what binds those to a real MCP server on a socket.
 */

import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'node:fs'

import { cwdFile, sidFile } from './paths'
import type { Registry } from './registry'
import type { SignalSource } from './subscription'
import type { TmResult, TmRunner } from './tm'
import { TM_VERBS } from './verbs'

/** The core-native tool that exposes the teammate registry. */
const TEAMMATES_TOOL = 'teammates'

/** Everything `createCore` needs; all of it is injectable for tests. */
export interface CoreDeps {
  /** Shells out to `tm` — the production runner or a fake. */
  runTm: TmRunner
  /** The teammate registry, already loaded. */
  registry: Registry
  /** The resident idle subscription (or any signal source), already started. */
  subscription: SignalSource
}

/** The transport-agnostic core: an MCP tool list and a dispatcher for them. */
export interface Core {
  /** Every MCP tool the core exposes — one per `tm` verb, plus `teammates`. */
  readonly tools: Tool[]
  /** Execute one MCP tool call. */
  handleTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>
}

/** Build the orchestration core. */
export function createCore(deps: CoreDeps): Core {
  const tools: Tool[] = [...TM_VERBS.map(verbTool), teammatesTool()]

  async function handleTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (name === TEAMMATES_TOOL) return listTeammates(deps)

    const verb = TM_VERBS.find((v) => v.name === name)
    if (!verb) return errorResult(`unknown tool: ${name}`)

    let argv: string[]
    let stdin: string | undefined
    let repo: string | undefined
    try {
      const rest = readArgv(args)
      stdin = readStdin(args)
      if (verb.registry === 'none') {
        argv = rest
      } else {
        // `spawn`/`resume`/`kill` carry the repo as a structured field, not
        // buried in the argument vector: the core needs the teammate identity
        // as data to key the registry, and a named field is robust to `tm`'s
        // per-verb flag ordering (`tm resume` accepts flags before the repo).
        // The repo is passed to `tm` as the first argument.
        repo = readRepo(args)
        argv = [repo, ...rest]
      }
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err))
    }

    let result: TmResult
    try {
      result = await deps.runTm(verb.name, argv, stdin != null ? { stdin } : undefined)
    } catch (err) {
      // A `tm` that cannot even be spawned (missing binary, exec failure) is
      // a tool error, not a crashed request — surface it as one.
      return errorResult(
        `could not run tm ${verb.name}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }

    // Reconcile the registry only after a verb that changed the teammate set
    // actually succeeded — a failed `tm spawn` did not create a teammate.
    if (result.code === 0 && repo && verb.registry !== 'none') {
      applyRegistryEffect(deps.registry, verb.registry, repo)
    }

    return verbResult(verb.name, result)
  }

  return { tools, handleTool }
}

/**
 * The MCP tool for one `tm` verb. A plain verb takes an opaque argument
 * vector; a registry-affecting verb (`spawn`/`resume`/`kill`) also takes a
 * required structured `repo`, because the core needs the teammate identity as
 * data — a named field is robust to `tm`'s per-verb flag ordering, where a
 * positional heuristic is not.
 */
function verbTool(verb: (typeof TM_VERBS)[number]): Tool {
  const stdin = {
    type: 'string' as const,
    description: 'Text fed to the verb on stdin. Only `archive` reads stdin.',
  }
  const description = `${verb.summary} Phase A: shells out to \`tm ${verb.name}\`.`
  if (verb.registry === 'none') {
    return {
      name: verb.name,
      description,
      inputSchema: {
        type: 'object',
        properties: {
          args: {
            type: 'array',
            items: { type: 'string' },
            description: `Arguments passed verbatim to \`tm ${verb.name}\`, in order.`,
          },
          stdin,
        },
      },
    }
  }
  return {
    name: verb.name,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description:
            'The teammate repo — the sibling directory name. Passed to `tm` ' +
            'as the first argument; the core keys the teammate registry on it.',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: `Arguments after \`<repo>\`, passed verbatim to \`tm ${verb.name}\`.`,
        },
        stdin,
      },
      required: ['repo'],
    },
  }
}

/** The core-native tool that lists the registry. */
function teammatesTool(): Tool {
  return {
    name: TEAMMATES_TOOL,
    description:
      'List the teammate registry — the core\'s authoritative teammate set, ' +
      'each annotated with its live busy/idle signal. Survives a core restart, ' +
      'unlike a `tm ls` tmux query.',
    inputSchema: { type: 'object', properties: {} },
  }
}

/** Build the `teammates` result: every registry entry plus its live signal. */
function listTeammates(deps: CoreDeps): CallToolResult {
  const teammates = deps.registry.list().map((entry) => ({
    ...entry,
    signal: entry.sid ? (deps.subscription.signalFor(entry.sid) ?? null) : null,
  }))
  return { content: [{ type: 'text', text: JSON.stringify({ teammates }, null, 2) }] }
}

/** Apply a verb's declared registry effect for a known repo. */
function applyRegistryEffect(
  registry: Registry,
  effect: 'record' | 'remove',
  repo: string,
): void {
  if (effect === 'remove') {
    registry.remove(repo)
    return
  }
  // `record`: `tm` has just written the repo-keyed `.sid` / `.cwd` files, so
  // the core reads the teammate's identity straight from the protocol files.
  registry.record({
    repo,
    sid: readTrimmed(sidFile(repo)),
    cwd: readTrimmed(cwdFile(repo)),
  })
}

/** Read and validate the required `repo` argument of a registry-affecting verb. */
function readRepo(args: Record<string, unknown>): string {
  const raw = args.repo
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('`repo` is required and must be a non-empty string')
  }
  return raw
}

/** Read and validate the `args` argument as a string vector; default empty. */
function readArgv(args: Record<string, unknown>): string[] {
  const raw = args.args
  if (raw === undefined) return []
  if (!Array.isArray(raw) || !raw.every((a) => typeof a === 'string')) {
    throw new Error('`args` must be an array of strings')
  }
  return raw
}

/** Read and validate the optional `stdin` argument. */
function readStdin(args: Record<string, unknown>): string | undefined {
  const raw = args.stdin
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw new Error('`stdin` must be a string')
  return raw
}

/** Read a file and trim it, or return `null` if it cannot be read. */
function readTrimmed(file: string): string | null {
  try {
    const text = readFileSync(file, 'utf8').trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/**
 * Render a `tm` invocation as an MCP result. A non-zero exit marks the result
 * `isError`; the text is `tm`'s own output.
 *
 * Many `tm` verbs print informational lines to stderr and still succeed —
 * `tm spawn` reports `spawned:` / `ready:` on stderr and exits 0. So stderr is
 * shown plainly when it is the only output; a `--- stderr ---` divider is
 * added only when *both* streams carry content, to keep them distinguishable
 * without dressing a normal success up as an error annex.
 */
function verbResult(verb: string, result: TmResult): CallToolResult {
  const out = result.stdout.replace(/\n+$/, '')
  const err = result.stderr.replace(/\n+$/, '')
  let text: string
  if (out && err) text = `${out}\n--- stderr ---\n${err}`
  else if (out || err) text = out || err
  else text = `tm ${verb} exited ${result.code} with no output`
  return {
    content: [{ type: 'text', text }],
    isError: result.code !== 0,
  }
}

/** A tool result flagged as an error. */
function errorResult(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}
