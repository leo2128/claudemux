# claudemux `bin/tm` — Architecture Review

Scope: `plugins/claudemux/bin/tm` (2023 lines) plus its co-process partners under
`plugins/claudemux/hooks/`, `plugins/claudemux/scripts/setup.sh`, and the test
fixtures under `tests/`. Read-only audit; no behavior was exercised.

---

## 1. Layered consistency

**现状**
There is a clear conceptual hierarchy: path builders (`session_name` 100, `sid_file` 106, `send_at_file` 107, `ready_file` 108, `cwd_file` 109, `memory_dir` 116) → pure formatters (`fmt_age` 174, `fmt_size` 184, `sanitize_task_slug` 128, `new_sid` 221) → IO middle (`resolve_sid` 153, `resolve_sid_or_die` 159, `pane_busy` 212, `clear_idle` 169, `require_session` 223, `resolve_pane_target` 101) → composable verb-internals (`_send_keys` 287, `_wait_idle_signal` 344, `_wait_pane_quiet` 362, `_print_last_or_empty` 391, `_echo_ctx_to_stderr` 414) → `cmd_*` verbs → `main` dispatcher. The split is real and mostly respected.

The leak is the **idle-dir filename scheme**. `$IDLE_DIR/<sid>`, `$IDLE_DIR/<sid>.busy`, `$IDLE_DIR/<sid>.last` are referenced as raw literals by `cmd_spawn` (572 — `: > "$IDLE_DIR/$sid.last"`), `cmd_last` (753 — `local lf="$IDLE_DIR/$sid.last"`), `cmd_states` (939 — `local lf="$IDLE_DIR/$sid.last"`), `cmd_compact` (1012, 1024), `_print_last_or_empty` (394), `_wait_idle_signal` (352), `_ctx_format_line` (not — uses jsonl), `pane_busy` (215). There is no `idle_marker_for() / last_file_for() / busy_marker_for()` analog to `sid_file()` etc. The path scheme is fixed by hooks too (`on-busy.sh` 32, `on-stop.sh` 199, 225), so the four sources of truth are *intentionally synchronized by convention* — but the convention lives in nine separate string concatenations across two scripts and one hook bundle.

A second, smaller leak: the jsonl path `$HOME/.claude/projects/<encoded-cwd>/<sid>.jsonl` is rebuilt by hand in `cmd_resume` (875–876), `_ctx_format_line` (1242–1243), `ctx_one` (1294–1295), and `cmd_history` (1318–1319). See §7 — these aren't byte-equal (an actual bug).

**判定:** ⚠️ 有隐患

**例子** — `cmd_kill` (767–780) uses every path-builder properly; `cmd_spawn` two lines later (572) writes `: > "$IDLE_DIR/$sid.last"` directly. Same author, same file, same protocol, two different abstraction levels.

**建议:** Promote `idle_marker_for(sid)`, `busy_marker_for(sid)`, `last_file_for(sid)` to first-class builders alongside `sid_file()`. Also a `jsonl_path_for(repo)` (see §7). Roughly 20 line edits; mostly mechanical.

---

## 2. Protocol contract — evolvability

**现状**
The cross-process file protocol is implicit in path naming and file *existence*:

| File                              | Writer                 | Reader                                      | Payload                |
|-----------------------------------|------------------------|---------------------------------------------|------------------------|
| `/tmp/teammate-<repo>.sid`        | `tm spawn`; `on-session-start.sh` | tm verbs (resolve_sid)                      | bare sid string         |
| `/tmp/teammate-<repo>.ready`      | `on-session-start.sh`  | `cmd_spawn` poll                            | none (mtime only)       |
| `/tmp/teammate-<repo>.cwd`        | `tm spawn`             | `on-session-start.sh`, `_ctx_format_line`   | physical-path string    |
| `/tmp/teammate-<repo>.send-at`    | `_send_keys`           | `_wait_pane_quiet`                          | none (mtime only)       |
| `/tmp/claude-idle/<sid>`          | `on-stop.sh`           | `_wait_idle_signal`, `cmd_compact`          | none (existence only)   |
| `/tmp/claude-idle/<sid>.busy`     | `on-busy.sh`           | `pane_busy`, `cmd_states`                   | none (existence only)   |
| `/tmp/claude-idle/<sid>.last`     | `on-stop.sh`           | `cmd_last`, `_print_last_or_empty`, `cmd_states`, `cmd_compact` | UTF-8 turn text       |

There is **no version field** anywhere. No `/tmp/teammate-<repo>.protocol`, no header line in any file. The single non-trivial payload (`<sid>.last`) is unformatted UTF-8.

Backward / forward compat today:
- Adding a new *file* type is safe (older readers ignore unknown filenames).
- Adding a *field* inside an existing file is impossible without breaking older readers — e.g. if `sid` ever needed an annotation, `resolve_sid` (155–157) does a bare `cat` and would consume the annotation verbatim into the sid string.
- Old teammate × new tm: if file shapes change, no way to detect. `tm doctor` does not even scan for orphaned/foreign-versioned files.
- Multi-user host: `/tmp/teammate-<repo>.sid` is unscoped by UID; two users on the same machine with the same `<repo>` collide silently. Likely out of scope for the product but worth naming.

**判定:** ⚠️ 有隐患 (acceptable today; locks in friction for the *first* schema change)

**例子** — `resolve_sid` (155): `[[ -s "$sf" ]] || return 1; cat "$sf"`. The whole-file `cat` is the protocol. The day this file gains *anything* other than a bare UUID, every reader breaks.

**建议:** Pick one of two cheap escape hatches *before* the first schema migration is needed:
(a) `/tmp/teammate-<repo>.proto` containing `{"version":1}` — readers gate behavior on it.
(b) Make `.sid` JSON from day one (`{"sid":"…","v":1}`) — readers go through one parse helper. (b) is more invasive but pays back if more fields ever land.

---

## 3. Error handling philosophy

**现状**
`set -euo pipefail` is set globally (50). The boundaries are surprisingly disciplined:

- Every command substitution that may legitimately produce no output is followed by `|| true` or guarded with `[[ -n "$x" ]]` (e.g. `cmd_archive` 1095, 1100, 1104; `iter_repos` 238).
- The `die`/`die_repo_not_found` pair is the single exit path for user-facing failures; everywhere else returns a numeric code.
- The `trap RETURN` in `_send_keys` (328) correctly handles paste-buffer cleanup on both normal return and `set -e` abort — and the `# shellcheck disable=SC2064` with reasoning is on the line that needed it.
- Hooks (`on-busy.sh`, `on-stop.sh`, `on-session-start.sh`) all `set -u` (not `-e`) and end with `exit 0` — correct for the hook contract ("never fail the turn").

Sharper edges:

1. `cmd_spawn` (586–592) polls for `$rf` for 18 s, then warns-and-continues on miss. The warning text (596) explicitly tells the user a downstream `tm send` will block until its 600 s timeout. This is documented friction, not a bug, but it means the *failure of the readiness contract is observable only via a long wait* and the cumulative `tm send` UX absorbs the cost.
2. `clear_idle` (170) uses `rm -f`, swallowing all failures. Good for the idempotency intent; bad if `/tmp/claude-idle/` is somehow unwritable, because the user-facing "stale state" symptom is hard to attribute.
3. The `wait_for_jsonl_terminal` polling in `on-stop.sh` (156–166) gives up silently after 3 s — and the comment at 211 explicitly notes that the *previous* behavior (rm `.last` on timeout) was worse. Good engineering, but the "timeout means we don't know" branch is now unobservable except via the diag log.

**判定:** ✅ 健康

The one tighten-up I'd recommend (in §3, not as top-3 debt): make `clear_idle` log on `rm` failure rather than silently swallow — same `2>/dev/null` flavor wouldn't help debug a `/tmp` permission regression.

---

## 4. Coupling — blast radius

| Coupling target                                                  | Touch sites                                                          | Replace cost                        |
|------------------------------------------------------------------|----------------------------------------------------------------------|-------------------------------------|
| `tmux` (send-keys, has-session, list-sessions, load-buffer, paste-buffer, capture-pane, kill-session, new-session) | All over `tm`; ~60 lines.                                            | ❌ Total rewrite. Fundamental.       |
| Claude Code hook event names + payload shape (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source`) | 3 hook scripts (`on-busy.sh` 27, `on-stop.sh` 47, `on-session-start.sh` 48–50). | ⚠️ Anthropic-controlled. A field rename breaks 3 files in parallel. |
| Claude Code project-dir encoding (`/` and `.` → `-`)              | `tm` (117, 875, 1242, 1294, 1318) + `setup.sh` (no — only paths the dispatcher itself owns). | ⚠️ Anthropic-controlled, encoding duplicated. See §1 / §7. |
| `claude --session-id <uuid>` flag                                | `cmd_spawn` 554                                                       | ⚠️ Single use site, Anthropic-controlled. |
| `claude --settings <json>` flag for `claudeMdExcludes`            | `cmd_spawn` 481, 546, 554                                             | ⚠️ Single use site. The exclusion key is also Anthropic-controlled. |
| External CLI: `uuidgen`, `jq`, `perl -CSD`, `awk`, `column`, `base64 --decode`, `stat -f`, `tail -r` / `tac` | Scattered. `stat -f` alone: 13 sites in tm + on-stop.sh. | ⚠️ BSD/GNU split. See top-3 #2.        |

The **most fragile** coupling isn't tmux (which is reasonable to depend on) — it's Claude Code's hook payload + project-dir encoding. Three hooks each pull `session_id` with `sed`. A field rename or shape change (e.g. payload becoming `{"event":{"session_id":…}}`) would break all three with no central choke point.

**判定:** ⚠️ 有隐患 (the Anthropic-side coupling is the real risk; tmux is fine)

**建议:** A tiny `parse_hook_payload` helper sourced by all three hook scripts would centralize the field extraction so the next contract change is one edit. Cost: small.

---

## 5. 2000-line monolith vs split

**现状**
2023 lines, 17 user verbs, 17 `help_*` siblings, ~20 helpers. Roughly 67 lines per verb on average. The test suite already had to work around the monolith: `tests/test_helper.bash` uses `sed '$d'` (26) to strip the final `main "$@"` so functions can be sourced into bats. That hack is a *signal*, not a problem yet.

Indicators **for** splitting:
- The test-helper `sed '$d'` workaround.
- Verb implementations and their `help_<verb>` texts are spatially far apart (`cmd_send` 621 / `help_send` 1722 — 1100 lines apart in a single file). The comment at 1670–1675 names this as "intentional, because adding a verb means: write cmd, write help" — but in practice the cognitive cost of paging between them is the real friction, not the dispatch case (which is 17 lines and trivially editable).
- Per-verb help bodies are pure docs and pure constants — easy to extract.

Indicators **against** splitting:
- Single author / single user today. Merge-conflict surface isn't realized.
- `set -euo pipefail` and the helper chain only need to be set up once; splitting forces a `lib/common.sh` source pattern that has its own debugging cost.
- Plugin packaging treats `bin/tm` as one file. Adding `bin/tm` + `bin/tm-helpers.sh` is doable but means the executable contract has dependencies again.

**判定:** ✅ 健康 (today). The right next move when this stops being healthy is **extract `help_*` first** — they're 280 lines of pure strings and they'd shrink `bin/tm` to ~1740 lines without any logic change. That's a free first step.

**信号 to revisit:**
- A second maintainer joins and merge conflicts on `bin/tm` happen monthly.
- Help bodies grow past ~400 lines combined.
- A second tool wants to reuse `_send_keys` / `_wait_idle_signal` / hook-related path builders.

---

## 6. CLAUDE.md rules vs code reality

The root `CLAUDE.md` has four behavioral sections. Auditing `bin/tm` and the hook scripts against each:

| Rule                                       | Conformance | Evidence |
|--------------------------------------------|-------------|----------|
| **Verify before acting**                   | ✅           | `require_session`, `resolve_sid_or_die`, `die_repo_not_found`, `sid` UUID regex (897), prefix-uniqueness check in `history_detail` (1399–1402) — all do *verify then act*. |
| **Audience boundaries — keep fixed contracts exact** | ✅           | The "load-bearing across this script" comment at 224 names the `$repo (tmux=$name)` output format; spawn (547, 555), kill (776), `require_session` die path (230) all match. |
| **Writing agent instructions — don't explain why a rejected alternative is wrong** | ⚠️ Two violations | (a) `on-stop.sh` 210–214: *"CHANGED: previously rm -f'd .last here. Timeout means 'we don't know' not 'confirmed empty'; destroying any prior .last that may still be valid amplifies the break (advisor flagged this)."* This is exactly the "history of what it replaced" pattern CLAUDE.md tells us to drop — a fresh reader sees a phantom alternative they never knew existed. (b) `tm` 191–194 names a "bug that motivated the empty-sentinel write at spawn time" — borderline; it does explain a current invariant, but via the historical bug rather than the rule. |
| **Slash command methodology** (audience-aware docs) | ✅           | `help_*` bodies in `tm` are user-facing and consistently phrased as user instructions, not as policy. |
| **Versioning** (pre-commit nudge)         | ✅           | `plugin.json` is at 0.5.1, matches the latest commit subject. The `.githooks/pre-commit` hook enforces the rule mechanically. |

**判定:** ⚠️ 有隐患 — small but real. The "rejected alternative" anti-pattern in `on-stop.sh` is the cleanest CLAUDE.md violation I can point at.

**建议:** Rewrite `on-stop.sh` 210–214 as the *current rule*: *"On timeout, leave `.last` untouched — a 3s poll miss does not prove the file is stale, and dropping it here would erase the prior turn's settled content."* No mention of what the code used to do.

---

## 7. `tm doctor` coverage vs real regression surface

`cmd_doctor` (1514–1618) checks:
- tm executable path + reported plugin version
- `TM_DISPATCHER_DIR` env vs `$PWD` (and divergence warning)
- `tmux` installed / server running / are-we-inside-tmux
- `/tmp/claude-idle` exists, file count
- Active teammate sessions (count + names)

**Gaps versus the failure modes this codebase actually has:**

| Real regression / failure                                                                  | Caught by `tm doctor`? |
|---------------------------------------------------------------------------------------------|-------------------------|
| `jq` not on PATH (used by `cmd_archive`, `cmd_ctx`, `cmd_history`, `on-stop.sh`, `setup.sh`, `bump-version`) | ❌                       |
| `perl` not on PATH (used by `sanitize_task_slug`, preview truncation in `cmd_states`, `cmd_history`) | ❌                       |
| `uuidgen` not on PATH (needed for every `tm spawn`)                                          | ❌                       |
| `claude` CLI not on PATH (the actual delegate)                                               | ❌                       |
| Claudemux plugin's hooks not actually loaded (e.g. user ran `tm` standalone)                 | ❌ (no probe writes anything that a hook would respond to) |
| Stale `/tmp/teammate-<repo>.sid` whose `<repo>` has no live tmux session                     | ❌ (idle dir count is shown but not cross-checked against tmux ls) |
| `/tmp/claude-idle/` exists but is **not writable**                                           | ❌ (`-d` test only)      |
| Dispatcher's `.claude/settings.json` was written by setup.sh but has since been hand-edited and lost `TM_DISPATCHER_DIR` | Partial (env check catches it, but doesn't read settings.json) |
| Recent on-stop.sh diag log entries showing repeated "timeout" branches                      | ❌                       |
| OS is Linux and `stat -f` is silently degrading every size/age field                         | ❌ (see top-3 #2)        |

The doctor checks what the *original sin* of the project was (TM_DISPATCHER_DIR drift) plus generic tmux liveness. It does not check what current bugs and regressions actually look like.

**判定:** ⚠️ 有隐患

**建议:** Add a `dependencies` section that probes `command -v` for `jq`, `perl`, `uuidgen`, `claude`. Add a `consistency` section that lists `/tmp/teammate-*.sid` entries whose paired tmux session is gone. These are 30 lines of additions and cover ~80% of "what went wrong" reports for a user who only knows to run `tm doctor`.

---

## Top-3 architectural debts

Ordered by **impact × inverse cost** (highest impact + lowest cost first).

### #1 — Project-dir encoding is duplicated 5 sites, one of which is wrong

**Simplest, smallest, real bug.**

`tm` encodes a cwd to a Claude Code project-dir name by replacing `/` and `.` with `-`. This is done in five places:

- `memory_dir` (117): `tr './' '-'` ✅
- `cmd_resume` (875): `tr / -` ❌ — does **not** translate dots
- `_ctx_format_line` (1242): `tr './' '-'` ✅
- `ctx_one` (1294): `tr './' '-'` ✅
- `cmd_history` (1318): `tr './' '-'` ✅

For any repo whose physical path contains a `.` (e.g. `~/Development/foo.bar/repo`, or any path under a hidden parent like `~/.config-style/...`), `cmd_resume` builds a project-dir name Claude Code never used, fails to find any jsonl, and dies with "no project dir" — *for a repo that absolutely has one*. The other four sites work correctly on that same repo.

- **影响面:** 1 verb (`cmd_resume`) is buggy in a real corner case; 5 sites of duplicated string logic.
- **成本:** small
- **第一步:** extract `project_dir_for_repo(repo)` that returns `$HOME/.claude/projects/<encoded>`, called from all 5 sites. ~15-line patch.

### #2 — macOS-only `stat -f` everywhere makes the cross-platform CI a lie

`bin/tm` and `hooks/on-stop.sh` use BSD `stat -f` syntax in 13 sites: `stat -f %z` (file size, lines 186, 942, 1408, 1453 etc.), `stat -f %m` (mtime, lines 368, 942, 1371, 1409), `stat -f %Sm` (formatted mtime, line 887). The GNU equivalents are `stat -c %s`, `stat -c %Y`, `date -d @<ts>`.

The CI matrix (`.github/workflows/ci.yml`) runs on both `macos-latest` and `ubuntu-latest`. The Linux job apparently passes — but only because every `stat -f` call is followed by `|| echo 0` (or `2>/dev/null || echo 0`), so on Linux the actual return value is silently `0`. That means on Linux:
- `cmd_states` shows every teammate's `LAST` as `0B/0s`
- `cmd_history` shows every session as same age, same size
- `_wait_pane_quiet`'s "≥3s since send" gate compares `now - 0` → always true → freshness guarantee disappears

The script claims portability (it's reused inside a plugin distributable via Claude Code on any OS Anthropic supports), but it is not portable. The pure-function bats tests cover none of the `stat` paths.

- **影响面:** ~13 sites in `tm`, 2 in `on-stop.sh`. Affects 4 verbs visibly (`states`, `history`, `ctx`, the pane-quiet branch).
- **成本:** small to medium
- **第一步:** add `stat_size()` / `stat_mtime()` helpers near the top of `bin/tm` that detect once (`stat -f %z /dev/null 2>/dev/null && BSD=1`) and dispatch. ~25 lines. Sweep call sites. Mirror in `on-stop.sh`.

### #3 — `IDLE_DIR` and jsonl-path literals scattered, no protocol version

A combined debt because they share root cause and root fix.

`$IDLE_DIR/<sid>`, `$IDLE_DIR/<sid>.busy`, `$IDLE_DIR/<sid>.last` are referenced as raw string concatenations in 9 sites across `tm` + 3 hook scripts. The protocol files under `/tmp/teammate-<repo>.*` and `/tmp/claude-idle/<sid>*` carry no version field anywhere — adding any structured payload to e.g. `.sid` requires touching every reader simultaneously.

The two pieces compound: if the file *content* needs to change (per §2), and the file *paths* live as 9 separate string literals (per §1), the next schema change is a 12-site sweep across two scripts and three hooks. The first time that's actually needed, the temptation to bypass it with a `/tmp/teammate-<repo>.sid.v2` parallel-protocol file will be high — which itself becomes more debt.

- **影响面:** 9 sites in `bin/tm` + 3 hooks. Touches the most-load-bearing convention in the codebase.
- **成本:** small
- **第一步:** extract `idle_marker_for(sid)`, `busy_marker_for(sid)`, `last_file_for(sid)`, `jsonl_path_for(repo)` as path builders next to `sid_file()`. Then, separately, decide whether to add a `protocol_version` header before the first schema change is needed (don't add prematurely — just *reserve the room*).

---

## CLAUDE.md candidate invariants

Three rules surfaced during audit that the codebase already follows (or *wants* to follow) but aren't pinned in `CLAUDE.md`:

1. **Path-builder discipline.** Every path under `/tmp/teammate-*` or `/tmp/claude-idle/*` and every `$HOME/.claude/projects/<encoded>/...` path must be constructed by a named builder function. No raw string concatenation at use sites. Rationale: the cross-process file protocol is *the* coupling layer in this codebase; spreading its shape across 12 string literals makes it un-evolvable.

2. **Cross-platform shell discipline.** Every command whose flags differ between BSD and GNU (`stat`, `sed -i`, `find -printf`, `date -d`, `tail -r` vs `tac`, `readlink -f`) must go through an OS-detected helper, *or* the script must declare itself macOS-only at the top. Rationale: this codebase already half-pretends to be portable (CI runs Linux), and silent degradation under `|| echo 0` is harder to catch than a hard error.

3. **One source of truth for the project-dir encoding.** Any code that needs to map a teammate cwd → Claude Code's project-dir name routes through one helper. Rationale: the encoding is an Anthropic-controlled contract; spreading the mapping across the codebase guarantees one site drifts when the contract is recreated (already happened, see top-3 #1).
