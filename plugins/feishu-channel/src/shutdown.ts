/**
 * Graceful shutdown.
 *
 * The channel server holds an open WebSocket and timers that pin the event
 * loop, so it must actively release them: a termination signal or the loss of
 * its stdio connection has to drive a clean exit, or the process leaks and
 * keeps a Feishu connection slot occupied.
 *
 * `ShutdownCoordinator` collects named cleanup tasks and runs them exactly
 * once, whatever triggers the shutdown. A watchdog timer force-exits if the
 * cleanup itself hangs — a stuck `close()` would otherwise leave the process
 * running forever, which is just another way to leak it. Every external
 * effect — OS signals, timers, process exit, error logging — is an injectable
 * dependency, so the whole lifecycle is unit-testable without signalling or
 * killing the test runner.
 */

/** A resource-releasing task. May be async. Run once, in registration order. */
export type CleanupTask = () => void | Promise<void>

/** A close-notifying source — both an MCP `Server` and its transport expose this. */
export interface Closable {
  onclose?: () => void
}

/** The external effects the coordinator needs, injectable for tests. */
export interface ShutdownDeps {
  /** Terminate the process. Injected so a test asserts it instead of dying. */
  exit: (code: number) => void
  /** Subscribe to an OS signal. Injected; defaults to `process.on`. */
  onSignal: (signal: string, handler: () => void) => void
  /** Report a cleanup task that threw. Injected; defaults to `console.error`. */
  logError: (message: string, err?: unknown) => void
  /** Schedule `fn` after `ms`; returns a handle for `clearTimer`. */
  setTimer: (fn: () => void, ms: number) => unknown
  /** Cancel a timer scheduled by `setTimer`. */
  clearTimer: (handle: unknown) => void
}

/** Signals that should drive a graceful shutdown. */
const SHUTDOWN_SIGNALS: readonly string[] = ['SIGTERM', 'SIGINT']

/** Default cap on how long graceful cleanup may run before a forced exit. */
const DEFAULT_FORCE_EXIT_MS = 10_000

function defaultLogError(message: string, err?: unknown): void {
  if (err === undefined) console.error(message)
  else console.error(message, err)
}

function defaultSetTimer(fn: () => void, ms: number): unknown {
  const handle = setTimeout(fn, ms)
  // The watchdog itself must not keep the event loop alive — that would be
  // the very leak it exists to prevent.
  handle.unref?.()
  return handle
}

export class ShutdownCoordinator {
  private readonly tasks: { name: string; run: CleanupTask }[] = []
  private readonly deps: ShutdownDeps
  /** Cap on how long graceful cleanup may run before the watchdog forces exit. */
  private readonly forceExitMs: number
  /** The in-flight (or settled) shutdown run; `undefined` until first triggered. */
  private shutdownRun: Promise<void> | undefined

  constructor(deps: Partial<ShutdownDeps> = {}, opts: { forceExitMs?: number } = {}) {
    this.forceExitMs = opts.forceExitMs ?? DEFAULT_FORCE_EXIT_MS
    this.deps = {
      exit: deps.exit ?? ((code) => process.exit(code)),
      onSignal: deps.onSignal ?? ((signal, handler) => process.on(signal, handler)),
      logError: deps.logError ?? defaultLogError,
      setTimer: deps.setTimer ?? defaultSetTimer,
      clearTimer:
        deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)),
    }
  }

  /** Register a named cleanup task. Tasks run in registration order on shutdown. */
  register(name: string, run: CleanupTask): void {
    this.tasks.push({ name, run })
  }

  /** Trigger a shutdown when SIGTERM or SIGINT arrives. */
  installSignalHandlers(): void {
    for (const signal of SHUTDOWN_SIGNALS) {
      this.deps.onSignal(signal, () => {
        void this.shutdown(0)
      })
    }
  }

  /**
   * Trigger a shutdown when `source` closes. Any `onclose` already set is
   * preserved and still runs, so attaching to an MCP `Server` does not drop
   * the server's own close handling.
   */
  watch(source: Closable): void {
    const previous = source.onclose
    source.onclose = () => {
      previous?.()
      void this.shutdown(0)
    }
  }

  /** True once a shutdown has been triggered — lets callers skip duplicated work. */
  get started(): boolean {
    return this.shutdownRun !== undefined
  }

  /**
   * Run every registered cleanup task once, then exit with `code`.
   *
   * Idempotent: re-entrant triggers (a signal racing the transport's onclose,
   * or two signals) all return the same in-flight run, so the tasks and the
   * exit happen exactly once. A task that throws is logged and does not stop
   * the remaining tasks — one stuck resource must not strand the others. A
   * watchdog forces the exit if cleanup as a whole runs past `forceExitMs`,
   * so a task that hangs (rather than throws) cannot pin the process open.
   */
  shutdown(code = 0): Promise<void> {
    if (!this.shutdownRun) {
      this.shutdownRun = this.runShutdown(code)
    }
    return this.shutdownRun
  }

  private async runShutdown(code: number): Promise<void> {
    let exited = false
    const finish = (): void => {
      if (exited) return
      exited = true
      this.deps.exit(code)
    }

    const watchdog = this.deps.setTimer(() => {
      this.deps.logError(`graceful shutdown exceeded ${this.forceExitMs}ms — forcing exit`)
      finish()
    }, this.forceExitMs)

    try {
      for (const task of this.tasks) {
        try {
          await task.run()
        } catch (err) {
          this.deps.logError(`shutdown task "${task.name}" failed`, err)
        }
      }
    } finally {
      this.deps.clearTimer(watchdog)
    }
    finish()
  }
}
