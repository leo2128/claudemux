/**
 * The `column` shell-out layer.
 *
 * `tm states` (and, later, `tm history`) render their tables by piping
 * tab-separated rows through `column -t`. The native verbs keep the row
 * *logic* in the core but delegate the final alignment to the real `column`
 * binary, the way `ls` delegates the session query to `tmux`.
 *
 * `column` is not reimplemented in TypeScript on purpose: how it measures a
 * field's width — bytes, characters, or display columns — is implementation-
 * and locale-dependent and differs between the BSD (macOS) and GNU (Linux)
 * builds, and `column`'s exact output *is* the behavior Phase B must preserve.
 * A hand-written aligner counting code units could not stay faithful to it;
 * the installed binary, whichever build it is, is faithful to itself.
 * `column` is a presentation backend here, the way `tmux` is the session
 * backend.
 */

/** The outcome of one `column` invocation — the same shape `runTmux` returns. */
export interface ColumnResult {
  /** Process exit code. */
  code: number
  /** Captured standard output — the aligned table. */
  stdout: string
  /** Captured standard error. */
  stderr: string
}

/**
 * Aligns tab-separated rows. Injectable: native verbs depend on this type,
 * not the concrete function, so a unit test can supply a stub.
 */
export type ColumnRunner = (input: string) => Promise<ColumnResult>

/**
 * The production `ColumnRunner`: pipe `input` through `column -t -s <TAB>` —
 * the exact invocation `tm` uses — and capture its exit code, stdout, and
 * stderr. The caller propagates a non-zero exit; `tm`'s `cmd_states` does the
 * same, its `column` pipeline running under `set -o pipefail`.
 */
export const runColumn: ColumnRunner = async (input) => {
  const proc = Bun.spawn(['column', '-t', '-s', '\t'], {
    stdin: new TextEncoder().encode(input),
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}
