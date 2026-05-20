# Domain: the cross-process file protocol

This is the contract that couples the two halves of claudemux. `tm` runs
inside the dispatcher; the hooks run inside every teammate. They are
separate processes in separate `tmux` sessions — they **never call each
other**. They communicate entirely through files in well-known locations.

If your task reads or writes any of these files, or changes a `tm`↔hook
seam, read this whole document first.

## Two keying schemes — and why

The protocol uses two namespaces, on purpose:

- **Repo-keyed** — `/tmp/teammate-<repo>.*`. Stable across a teammate's
  whole life. `<repo>` is the sibling directory name. `tm` owns these:
  they are how `tm` finds a teammate given a repo name the user typed.
- **Sid-keyed** — `/tmp/claude-idle/<sid>.*`. Keyed by Claude Code's
  `session_id`. The hooks own these: a hook only knows its own
  `session_id`, never a repo name. A `session_id` rotates on `/clear` and
  `/resume`.

The bridge between the two is `/tmp/teammate-<repo>.sid`, which stores the
current `<sid>` for `<repo>`. `tm` reads it to translate a repo name into
the sid-keyed marker paths the hooks maintain. The `SessionStart` hook
rewrites it when the session_id rotates — without that, `tm states` /
`last` / `wait` would all consult a dead sid.

## The protocol files

### Repo-keyed — `/tmp/teammate-<repo>.*`

| File | Builder (`tm`) | Contents | Writer | Reader |
|---|---|---|---|---|
| `.sid` | `sid_file` | UUID of the active session | `tm spawn`/`resume`; `on-session-start.sh` on rotation | `tm` (every verb, via `resolve_sid`) |
| `.cwd` | `cwd_file` | Physical cwd of the repo at spawn time | `tm spawn` | `on-session-start.sh` (the cwd-match identity gate) |
| `.ready` | `ready_file` | Empty marker — REPL is up | `on-session-start.sh` | `tm spawn` (poll loop) |
| `.send-at` | `send_at_file` | Empty; the *mtime* is the timestamp of the last send | `tm` (`_send_keys`) | `tm` (`_wait_pane_quiet`) |

### Sid-keyed — `/tmp/claude-idle/<sid>.*`

| File | Builder | Contents | Writer | Reader |
|---|---|---|---|---|
| `<sid>` | `idle_marker_for` | Empty marker — the session reached an idle/done event | `on-stop.sh` | `tm` waiting verbs (`send`, `wait`, `compact`, `spawn --prompt`) |
| `<sid>.busy` | `busy_marker_for` | Empty marker — the session is mid-turn | `on-busy.sh` (set), `on-stop.sh` (clear) | `tm` (`pane_busy`, `tm states`) |
| `<sid>.last` | `last_file_for` | Text of the last *assistant* turn | `on-stop.sh` (on `Stop` only) | `tm last`/`send`/`wait`/`states` |

### Other shared paths

| Path | Role |
|---|---|
| `/tmp/claude-idle/_on-stop.log` | `on-stop.sh` diagnostic log, one line per phase per fire |
| `/tmp/claudemux-sid-changes.log` | `on-session-start.sh` audit log of every sid rotation |
| `~/.claude/projects/<encoded>/*.jsonl` | Claude Code session transcripts; `tm history`/`ctx`/`resume` parse them |
| `~/.claude/projects/<encoded>/memory/` | AutoMemory; `tm mem` cats a sibling repo's `MEMORY.md` |

`/tmp/claude-idle/` files older than 7 days are swept by `on-stop.sh`
(~1/16 of fires, in the background) — `tm kill` only cleans up sessions it
spawned, so ad-hoc and orphaned sessions would otherwise accumulate forever.

## The two invariants this protocol depends on

These are repo-`CLAUDE.md` invariants; they exist *because of* this
protocol, and [decision 0004](/.agents/decisions/0004-cross-process-cross-platform-invariants.md)
records the drift each one came from.

1. **Path-builder discipline.** Every path above is constructed by a named
   builder function — `sid_file`, `idle_marker_for`, `encode_project_dir`,
   … — never by raw string concatenation at a use site. This protocol is
   *the* coupling layer; spreading its shape across many string literals
   turns the next schema change into an un-atomic multi-file sweep. The
   hooks cannot `source` `tm`, so they re-declare the builders inline — the
   discipline is "a named function at every site", not "one definition".
2. **One source of truth for the project-dir encoding.** The map from a
   teammate cwd to `~/.claude/projects/<encoded>` replaces every `/` *and*
   `.` with `-`. It is an Anthropic-controlled contract. All code routes
   through `encode_project_dir` (and `project_dir_for_repo`); hand-coding
   it has already silently dropped dots and broken `tm resume`.

## Ordering rule inside `on-stop.sh`

`on-stop.sh` writes `<sid>.last` **before** it touches the `<sid>` idle
marker. A `tm` waiter races on the idle-marker touch and then immediately
reads `.last`; doing `.last` first guarantees the waiter never sees the
idle marker without the matching reply already in place.

## Event coverage rule

`on-busy.sh` is bound to all four idle→working events; `on-stop.sh` to all
four working→idle events. The sets are exhaustive on purpose: a `tm wait`
that only woke on `Stop` would hang forever on a `/compact` turn (ends on
`PostCompact`) or an API-error turn (`StopFailure`). See
[decision 0001](/.agents/decisions/0001-hook-driven-busy-idle-signal.md).

## See also

- [components/tm.md](/.agents/components/tm.md) — the consumer side.
- [components/hooks.md](/.agents/components/hooks.md) — the producer side.
