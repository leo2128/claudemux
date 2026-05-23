/**
 * `encodeProjectDir` — the one-and-only mapping from a filesystem path to
 * Claude Code's on-disk project-dir segment under `~/.claude/projects/`.
 *
 * Decision 0004 §"One source of truth for the project-dir encoding" pins
 * this as the single seam: every site that needs to locate a Claude Code
 * project directory routes through here, or two callers end up addressing
 * the same repo by two different strings.
 *
 * Claude Code derives the name by replacing every character that is not
 * ASCII-alphanumeric or `-` with `-`. The rule was probed empirically:
 * cwds containing `_`, `+`, `.`, `,`, `:`, `!`, `@`, `;`, or a literal
 * space all land at the same `-bar` directory; only `A-Z`, `a-z`, `0-9`,
 * and `-` survive verbatim. This is an Anthropic-controlled contract.
 */

export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-')
}
