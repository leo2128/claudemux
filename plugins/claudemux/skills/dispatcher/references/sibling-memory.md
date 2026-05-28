# Sibling-repo memory lookup (scenario reference)

Read this whenever you are about to compose a `tm spawn` / `tm send --prompt` whose text quotes sibling-repo state — feature-gate names, branch names, in-progress projects, "the owner of the X refactor". The dispatcher's own auto-memory does NOT include sibling repo memories, so a remembered-feeling fact may have been read from a stale snapshot or never recorded at all. Pull the index from the right sibling first.

Skip this when you are answering the user from dispatcher context only (e.g. "what teammates are running") or routing them to an already-live teammate without injecting sibling state into a new prompt — `tm states` and the ledger are enough there.

## The verb: `tm mem`

`tm mem <name>` cats the sibling repo's `MEMORY.md` to stdout. Missing memory (the repo has never run claude, or its project dir was pruned) is a normal case, not an error: stderr gets a one-line notice and the exit status is 0 with empty stdout. Treat empty output as "no sibling memory available — proceed without."

Run `tm mem --help` for the full contract.

## When to call it

| Situation | Call `tm mem`? |
|---|---|
| About to write `tm spawn <path> --prompt "..."` that names a feature gate, branch, owner, or in-progress project in `<path>` | Yes — before composing the prompt |
| About to write `tm send <name> --prompt "..."` that references sibling state | Yes — same reason |
| Answering the user from dispatcher context only | No — `tm states` / ledger suffice |
| Routing to an already-running teammate without quoting sibling state | No |

The trigger is "I am about to inject a fact about repo X into a teammate's prompt." The teammate has no original context to judge whether the fact is fresh — that is why the verification step has to happen here, before the prompt is sent.

## Verify before injecting

Memory entries can be stale. A feature-gate name may have been renamed, a branch merged and deleted, an "in-progress" project shipped weeks ago. Before pasting a sibling fact into a teammate's prompt, confirm against current code or git state:

- Branch name → `git -C <dispatcher-dir>/<repo> branch --show-current` (or `git -C ... ls-remote` for upstream)
- Feature-gate / config name → grep the actual sibling repo
- "Current owner / in-progress project" → check the dispatcher ledger or recent git log

This is the same verify-before-recommend rule that applies to the dispatcher's own memory.

`tm mem` owns the project-dir encoding and `<dispatcher-dir> → <repo> → physical cwd` resolution. Use the verb rather than hand-rolling `$HOME/.claude/projects/<encoded>/memory/` paths.

## Foot-guns

- **Don't `tm spawn <path>` just to populate its memory.** Spawning starts a teammate; the memory file is only written when that teammate's AutoMemory hook fires on a turn. If `tm mem <name>` is empty, that is the data — proceed without sibling context, or pause and ask the user to fill in what you would otherwise have guessed.
- **Don't paste the sibling MEMORY.md wholesale into a teammate's prompt.** The teammate will load its own auto-memory at session start; quoting the index in the bootstrap is duplicative and locks stale entries into the teammate's context window. Pull the one or two facts you need, verify them, and inline only those.
