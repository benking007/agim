/**
 * useEventStream — verify:
 *   * Subscribes to typed events (audit/approval/job/metrics/hello)
 *     and calls the matching handler with parsed payload
 *   * Status transitions: connecting → connected → reconnecting
 *   * Unmount closes the EventSource and removes the listeners
 *   * visibilitychange to "visible" reopens if currently disconnected
 *   * Malformed JSON in event data is swallowed (no handler call)
 *
 * jsdom doesn't ship a global EventSource. We install a controllable
 * mock on globalThis before each test and drive it manually.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, renderHook } from '@testing-library/react'
import { useEventStream } from './use-event-stream'

type Listener = (event: MessageEvent) => void

class MockEventSource {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 2

  static instances: MockEventSource[] = []

  readyState: number = MockEventSource.CONNECTING
  closed = false
  listeners = new Map<string, Listener[]>()

  // Properties EventSource exposes that the hook touches.
  url: string
  withCredentials: boolean

  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url
    this.withCredentials = !!init?.withCredentials
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const arr = this.listeners.get(type) ?? []
    arr.push(listener)
    this.listeners.set(type, arr)
  }

  removeEventListener(type: string, listener: Listener): void {
    const arr = this.listeners.get(type) ?? []
    this.listeners.set(type, arr.filter((l) => l !== listener))
  }

  close(): void {
    this.closed = true
    this.readyState = MockEventSource.CLOSED
  }

  /** Test helper — fire a synthetic SSE event. */
  fire(type: string, data: unknown): void {
    const ev = new MessageEvent(type, { data: typeof data === 'string' ? data : JSON.stringify(data) })
    for (const l of this.listeners.get(type) ?? []) l(ev)
  }

  /** Test helper — mark as connected and fire open. */
  open(): void {
    this.readyState = MockEventSource.OPEN
    for (const l of this.listeners.get('open') ?? []) l(new MessageEvent('open'))
  }

  /** Test helper — fire error event. */
  errorEvt(): void {
    this.readyState = MockEventSource.CONNECTING
    for (const l of this.listeners.get('error') ?? []) l(new MessageEvent('error'))
  }
}

const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource

beforeEach(() => {
  MockEventSource.instances = []
  ;(globalThis as { EventSource?: unknown }).EventSource = MockEventSource as unknown as typeof EventSource
})

afterEach(() => {
  if (originalEventSource === undefined) {
    delete (globalThis as { EventSource?: unknown }).EventSource
  } else {
    ;(globalThis as { EventSource?: unknown }).EventSource = originalEventSource
  }
})

describe('useEventStream', () => {
  it('opens an EventSource against /events with withCredentials', () => {
    renderHook(() => useEventStream({}))
    expect(MockEventSource.instances).toHaveLength(1)
    expect(MockEventSource.instances[0]!.url).toBe('/events')
    expect(MockEventSource.instances[0]!.withCredentials).toBe(true)
  })

  it('respects a custom url option', () => {
    renderHook(() => useEventStream({}, { url: '/api/events?token=t' }))
    expect(MockEventSource.instances[0]!.url).toBe('/api/events?token=t')
  })

  it('does not connect when enabled=false', () => {
    const { result } = renderHook(() => useEventStream({}, { enabled: false }))
    expect(MockEventSource.instances).toHaveLength(0)
    expect(result.current).toBe('closed')
  })

  it('dispatches typed events to matching handlers', () => {
    const job = vi.fn()
    const approval = vi.fn()
    renderHook(() => useEventStream({ job, approval }))

    const es = MockEventSource.instances[0]!
    act(() => {
      es.fire('job', { type: 'job', phase: 'created', jobId: 7, agent: 'claude' })
    })
    expect(job).toHaveBeenCalledWith({ type: 'job', phase: 'created', jobId: 7, agent: 'claude' })

    act(() => {
      es.fire('approval', {
        type: 'approval',
        phase: 'requested',
        reqId: 'r1',
        threadId: 't1',
        platform: 'web',
        toolName: 'bash',
      })
    })
    expect(approval).toHaveBeenCalledTimes(1)
    expect(approval.mock.calls[0]![0]).toMatchObject({ reqId: 'r1', toolName: 'bash' })
  })

  it('ignores events without a matching handler', () => {
    const audit = vi.fn()
    renderHook(() => useEventStream({ audit }))
    const es = MockEventSource.instances[0]!
    act(() => {
      es.fire('job', { type: 'job', phase: 'started', jobId: 1, agent: 'x' })
    })
    expect(audit).not.toHaveBeenCalled()
  })

  it('swallows malformed JSON', () => {
    const job = vi.fn()
    renderHook(() => useEventStream({ job }))
    const es = MockEventSource.instances[0]!
    act(() => {
      es.fire('job', 'not-json{')
    })
    expect(job).not.toHaveBeenCalled()
  })

  it('status transitions connecting → connected → reconnecting', () => {
    const { result } = renderHook(() => useEventStream({}))
    expect(result.current).toBe('connecting')

    const es = MockEventSource.instances[0]!
    act(() => { es.open() })
    expect(result.current).toBe('connected')

    act(() => { es.errorEvt() })
    expect(result.current).toBe('reconnecting')
  })

  it('closes the EventSource on unmount', () => {
    const { unmount } = renderHook(() => useEventStream({}))
    const es = MockEventSource.instances[0]!
    expect(es.closed).toBe(false)
    unmount()
    expect(es.closed).toBe(true)
  })

  it('reopens on visibilitychange when readyState is not OPEN', () => {
    renderHook(() => useEventStream({}))
    const first = MockEventSource.instances[0]!
    // Simulate the socket dying without firing close (e.g. iOS suspend).
    first.readyState = MockEventSource.CLOSED

    // visibilitychange to "visible" → reopen
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'))
    })
    expect(MockEventSource.instances.length).toBeGreaterThanOrEqual(2)
    // Old one was closed by the reopen path.
    expect(first.closed).toBe(true)
  })

  it('reopens on window "online" event', () => {
    renderHook(() => useEventStream({}))
    expect(MockEventSource.instances).toHaveLength(1)
    act(() => {
      window.dispatchEvent(new Event('online'))
    })
    expect(MockEventSource.instances).toHaveLength(2)
  })

  it('handler swaps without re-opening the connection', () => {
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ cb }: { cb: (e: unknown) => void }) =>
      useEventStream({ job: cb }), { initialProps: { cb: first } })
    expect(MockEventSource.instances).toHaveLength(1)

    rerender({ cb: second })
    // Still the same socket — handler ref tracks via useRef.
    expect(MockEventSource.instances).toHaveLength(1)

    const es = MockEventSource.instances[0]!
    act(() => {
      es.fire('job', { type: 'job', phase: 'created', jobId: 99, agent: 'a' })
    })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})

// Suppress unused-import — render is referenced via the test helpers above.
void render
