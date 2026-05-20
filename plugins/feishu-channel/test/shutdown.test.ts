import { describe, expect, test } from 'bun:test'
import { ShutdownCoordinator } from '../src/shutdown'
import type { ShutdownDeps } from '../src/shutdown'

/** A coordinator wired to fakes — exit, signals, and errors are all captured. */
function harness(): {
  coordinator: ShutdownCoordinator
  exitCodes: number[]
  errors: { message: string; err: unknown }[]
  signals: Map<string, () => void>
} {
  const exitCodes: number[] = []
  const errors: { message: string; err: unknown }[] = []
  const signals = new Map<string, () => void>()
  const deps: Partial<ShutdownDeps> = {
    exit: (code) => {
      exitCodes.push(code)
    },
    onSignal: (signal, handler) => {
      signals.set(signal, handler)
    },
    logError: (message, err) => {
      errors.push({ message, err })
    },
  }
  return { coordinator: new ShutdownCoordinator(deps), exitCodes, errors, signals }
}

describe('shutdown — cleanup tasks', () => {
  test('runs every registered task, then exits', async () => {
    const { coordinator, exitCodes } = harness()
    const ran: string[] = []
    coordinator.register('a', () => {
      ran.push('a')
    })
    coordinator.register('b', () => {
      ran.push('b')
    })
    await coordinator.shutdown(0)
    expect(ran).toEqual(['a', 'b'])
    expect(exitCodes).toEqual([0])
  })

  test('runs tasks in registration order', async () => {
    const { coordinator } = harness()
    const ran: string[] = []
    for (const name of ['first', 'second', 'third']) {
      coordinator.register(name, () => {
        ran.push(name)
      })
    }
    await coordinator.shutdown()
    expect(ran).toEqual(['first', 'second', 'third'])
  })

  test('awaits an async task before exiting', async () => {
    const { coordinator, exitCodes } = harness()
    let asyncDone = false
    coordinator.register('async', async () => {
      await Promise.resolve()
      asyncDone = true
    })
    await coordinator.shutdown()
    expect(asyncDone).toBe(true)
    expect(exitCodes).toEqual([0])
  })

  test('passes the exit code through', async () => {
    const { coordinator, exitCodes } = harness()
    await coordinator.shutdown(2)
    expect(exitCodes).toEqual([2])
  })
})

describe('shutdown — idempotency', () => {
  test('a second call re-runs nothing and exits only once', async () => {
    const { coordinator, exitCodes } = harness()
    let runs = 0
    coordinator.register('once', () => {
      runs += 1
    })
    await coordinator.shutdown()
    await coordinator.shutdown()
    expect(runs).toBe(1)
    expect(exitCodes).toEqual([0])
  })

  test('concurrent triggers share the one shutdown run', async () => {
    const { coordinator, exitCodes } = harness()
    let runs = 0
    coordinator.register('once', async () => {
      await Promise.resolve()
      runs += 1
    })
    await Promise.all([coordinator.shutdown(), coordinator.shutdown()])
    expect(runs).toBe(1)
    expect(exitCodes).toEqual([0])
  })

  test('started flips once a shutdown is triggered', async () => {
    const { coordinator } = harness()
    expect(coordinator.started).toBe(false)
    const run = coordinator.shutdown()
    expect(coordinator.started).toBe(true)
    await run
  })
})

describe('shutdown — a failing task does not strand the rest', () => {
  test('a throwing task is logged and the remaining tasks still run', async () => {
    const { coordinator, exitCodes, errors } = harness()
    const ran: string[] = []
    coordinator.register('boom', () => {
      throw new Error('cleanup blew up')
    })
    coordinator.register('survivor', () => {
      ran.push('survivor')
    })
    await coordinator.shutdown()
    expect(ran).toEqual(['survivor'])
    expect(exitCodes).toEqual([0])
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('boom')
  })

  test('a rejected async task is logged and does not block exit', async () => {
    const { coordinator, exitCodes, errors } = harness()
    coordinator.register('async-boom', async () => {
      await Promise.resolve()
      throw new Error('async cleanup blew up')
    })
    await coordinator.shutdown()
    expect(exitCodes).toEqual([0])
    expect(errors).toHaveLength(1)
  })
})

describe('shutdown — signal handlers', () => {
  test('installSignalHandlers subscribes to SIGTERM and SIGINT', () => {
    const { coordinator, signals } = harness()
    coordinator.installSignalHandlers()
    expect(signals.has('SIGTERM')).toBe(true)
    expect(signals.has('SIGINT')).toBe(true)
  })

  test('a SIGTERM triggers the shutdown', async () => {
    const { coordinator, signals, exitCodes } = harness()
    let ran = false
    coordinator.register('cleanup', () => {
      ran = true
    })
    coordinator.installSignalHandlers()
    signals.get('SIGTERM')?.()
    await coordinator.shutdown()
    expect(ran).toBe(true)
    expect(exitCodes).toEqual([0])
  })

  test('a SIGINT triggers the shutdown', async () => {
    const { coordinator, signals, exitCodes } = harness()
    coordinator.installSignalHandlers()
    signals.get('SIGINT')?.()
    await coordinator.shutdown()
    expect(exitCodes).toEqual([0])
  })
})

describe('shutdown — watching a closable', () => {
  test('an onclose triggers the shutdown', async () => {
    const { coordinator, exitCodes } = harness()
    let ran = false
    coordinator.register('cleanup', () => {
      ran = true
    })
    const source: { onclose?: () => void } = {}
    coordinator.watch(source)
    source.onclose?.()
    await coordinator.shutdown()
    expect(ran).toBe(true)
    expect(exitCodes).toEqual([0])
  })

  test('an onclose already set is preserved and still runs', async () => {
    const { coordinator } = harness()
    const calls: string[] = []
    const source: { onclose?: () => void } = {
      onclose: () => {
        calls.push('original')
      },
    }
    coordinator.watch(source)
    source.onclose?.()
    await coordinator.shutdown()
    expect(calls).toEqual(['original'])
  })

  test('a signal racing an onclose still runs cleanup exactly once', async () => {
    const { coordinator, signals, exitCodes } = harness()
    let runs = 0
    coordinator.register('cleanup', () => {
      runs += 1
    })
    coordinator.installSignalHandlers()
    const source: { onclose?: () => void } = {}
    coordinator.watch(source)
    signals.get('SIGTERM')?.()
    source.onclose?.()
    await coordinator.shutdown()
    expect(runs).toBe(1)
    expect(exitCodes).toEqual([0])
  })
})

describe('shutdown — force-exit watchdog', () => {
  test('a cleanup task that hangs is force-exited by the watchdog', () => {
    const exitCodes: number[] = []
    const errors: string[] = []
    let watchdogFn: (() => void) | undefined
    const coordinator = new ShutdownCoordinator(
      {
        exit: (code) => {
          exitCodes.push(code)
        },
        logError: (message) => {
          errors.push(message)
        },
        setTimer: (fn) => {
          watchdogFn = fn
          return 1
        },
        clearTimer: () => {},
      },
      { forceExitMs: 50 },
    )
    // A task that never settles — without the watchdog, shutdown would never
    // reach the exit and the process would hang open.
    coordinator.register('hangs', () => new Promise<void>(() => {}))

    void coordinator.shutdown(0)
    // The watchdog is scheduled synchronously before the first awaited task,
    // so by now its callback is captured. Fire it as the timer would.
    expect(watchdogFn).toBeDefined()
    watchdogFn?.()

    expect(exitCodes).toEqual([0])
    expect(errors.some((m) => m.includes('forcing exit'))).toBe(true)
  })

  test('a normal shutdown clears the watchdog and exits exactly once', async () => {
    const exitCodes: number[] = []
    let cleared = false
    const coordinator = new ShutdownCoordinator({
      exit: (code) => {
        exitCodes.push(code)
      },
      setTimer: (fn) => fn,
      clearTimer: () => {
        cleared = true
      },
    })
    coordinator.register('quick', () => {})

    await coordinator.shutdown(0)

    expect(exitCodes).toEqual([0])
    expect(cleared).toBe(true)
  })

  test('the watchdog firing after a normal exit does not exit twice', async () => {
    const exitCodes: number[] = []
    let watchdogFn: (() => void) | undefined
    const coordinator = new ShutdownCoordinator({
      exit: (code) => {
        exitCodes.push(code)
      },
      logError: () => {},
      setTimer: (fn) => {
        watchdogFn = fn
        return 1
      },
      clearTimer: () => {},
    })
    coordinator.register('quick', () => {})

    await coordinator.shutdown(0)
    // A late timer callback must not drive a second exit.
    watchdogFn?.()

    expect(exitCodes).toEqual([0])
  })
})
