/**
 * The `grep` shell-out layer.
 *
 * `tm poll` blocks until a teammate's pane matches a regex — `tmux capture-pane
 * | grep -qE <pattern>`. The native `poll` verb keeps the poll loop in the
 * core but delegates the match itself to the real `grep`, the way `states`
 * delegates alignment to `column`.
 *
 * `grep` is not reimplemented in TypeScript on purpose: its `-E` dialect is
 * POSIX extended regular expressions, which a JavaScript `RegExp` does not
 * reproduce — `\d`, lookahead, and POSIX character classes all differ — and
 * the pattern is `poll`'s user-facing surface, so a behavior-preserving
 * migration must match `grep` exactly. The installed `grep` is faithful to
 * itself.
 */

/**
 * Runs `grep -qE <pattern>` over `input` and resolves with its exit code:
 * `0` a match, `1` no match, `2` a `grep` error (an invalid pattern). `poll`
 * treats only `0` as a match — exactly `tm`'s `if ... | grep -qE`.
 *
 * Injectable: the native `poll` verb depends on this type, not the concrete
 * function, so a test can supply a stub.
 */
export type GrepRunner = (pattern: string, input: string) => Promise<number>

/**
 * The production `GrepRunner`: pipe `input` through `grep -qE <pattern>` —
 * the exact invocation `tm poll` uses — and resolve with its exit code. The
 * pattern is passed as its own argument with no `--` guard, matching `tm`, so
 * a pattern that begins with `-` is read by `grep` as a flag just as it is
 * under `tm`.
 */
export const runGrep: GrepRunner = async (pattern, input) => {
  const proc = Bun.spawn(['grep', '-qE', pattern], {
    stdin: new TextEncoder().encode(input),
    stdout: 'ignore',
    stderr: 'ignore',
    env: process.env,
  })
  return proc.exited
}
