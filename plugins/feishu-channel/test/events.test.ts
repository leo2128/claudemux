import { describe, expect, test } from 'vitest'
import { EventRegistry } from '../src/events'
import type { ChannelDelivery, EventHandler, HandlerContext } from '../src/events'

/** A no-op handler for one event_type — enough to exercise the registry. */
function fakeHandler(
  eventType: string,
  result: ChannelDelivery | null = null,
): EventHandler {
  return {
    eventType,
    async handle(): Promise<ChannelDelivery | null> {
      return result
    },
  }
}

describe('EventRegistry — registration', () => {
  test('a registered handler is retrievable by its event_type', () => {
    const handler = fakeHandler('im.message.receive_v1')
    const registry = new EventRegistry().register(handler)

    expect(registry.get('im.message.receive_v1')).toBe(handler)
    expect(registry.has('im.message.receive_v1')).toBe(true)
  })

  test('register returns the registry so calls can be chained', () => {
    const registry = new EventRegistry()
      .register(fakeHandler('a.event'))
      .register(fakeHandler('b.event'))

    expect(registry.has('a.event')).toBe(true)
    expect(registry.has('b.event')).toBe(true)
  })

  test('registering two handlers for one event_type throws', () => {
    const registry = new EventRegistry().register(fakeHandler('dup.event'))

    expect(() => registry.register(fakeHandler('dup.event'))).toThrow(
      'duplicate handler for event type: dup.event',
    )
  })
})

describe('EventRegistry — lookup', () => {
  test('get returns undefined for an unregistered event_type', () => {
    const registry = new EventRegistry()
    expect(registry.get('never.registered')).toBeUndefined()
    expect(registry.has('never.registered')).toBe(false)
  })

  test('eventTypes lists every registered type in registration order', () => {
    const registry = new EventRegistry()
      .register(fakeHandler('first.event'))
      .register(fakeHandler('second.event'))
      .register(fakeHandler('third.event'))

    expect(registry.eventTypes()).toEqual(['first.event', 'second.event', 'third.event'])
  })

  test('a fresh registry has no event types', () => {
    expect(new EventRegistry().eventTypes()).toEqual([])
  })
})

describe('EventRegistry — handler contract', () => {
  test('a resolved handler runs and yields its delivery', async () => {
    const delivery: ChannelDelivery = { content: 'hi', meta: { kind: 'message' } }
    const registry = new EventRegistry().register(fakeHandler('some.event', delivery))

    const handler = registry.get('some.event')
    expect(handler).toBeDefined()
    // The context is opaque to the registry; a handler under test that
    // ignores it accepts any object shaped as a HandlerContext.
    const ctx = {} as HandlerContext
    expect(await handler?.handle({}, ctx)).toEqual(delivery)
  })
})
