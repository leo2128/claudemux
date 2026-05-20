/**
 * Graceful shutdown.
 *
 * The channel server holds an open WebSocket and timers that pin the event
 * loop, so it must actively release them: a termination signal or the loss of
 * its stdio connection has to drive a clean exit, or the process leaks and
 * keeps a Feishu connection slot occupied.
 *
 * `ShutdownCoordinator` collects named cleanup tasks and runs them exactly
 * once, whatever triggers the shutdown. Every external effect — OS signals,
 * process exit, error logging — is an injectable dependency, so the whole
 * lifecycle is unit-testable without signalling or killing the test runner.
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
  logError: (message: string, err: unknown) => void
}

/** Signals that should drive a graceful shutdown. */
const SHUTDOWN_SIGNALS: readonly string[] = ['SIGTERM', 'SIGINT']

export class ShutdownCoordinator {
  private readonly tasks: { name: string; run: CleanupTask }[] = []
  private readonly deps: ShutdownDeps
  /** The in-flight (or settled) shutdown run; `undefined` until first triggered. */
  private shutdownRun: Promise<void> | undefined

  constructor(deps: Partial<ShutdownDeps> = {}) {
    this.deps = {
      exit: deps.exit ?? ((code) => process.exit(code)),
      onSignal: deps.onSignal ?? ((signal, handler) => process.on(signal, handler)),
      logError: deps.logError ?? ((message, err) => console.error(message, err)),
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
   * the remaining tasks — one stuck resource must not strand the others.
   */
  shutdown(code = 0): Promise<void> {
    if (!this.shutdownRun) {
      this.shutdownRun = this.runShutdown(code)
    }
    return this.shutdownRun
  }

  private async runShutdown(code: number): Promise<void> {
    for (const task of this.tasks) {
      try {
        await task.run()
      } catch (err) {
        this.deps.logError(`shutdown task "${task.name}" failed`, err)
      }
    }
    this.deps.exit(code)
  }
}
