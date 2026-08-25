/**
 * Chat WS singleton — resume reconnect (iOS/macOS WKWebView zombie sockets).
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { shouldForceResumeReconnect, WS_RESUME_DEBOUNCE_MS } from './ws'

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []

  readyState = MockWebSocket.CONNECTING
  url: string
  sent: string[] = []
  private listeners = new Map<string, Set<(ev: Event) => void>>()

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  addEventListener(type: string, fn: (ev: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(fn)
    this.listeners.set(type, set)
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return
    this.readyState = MockWebSocket.CLOSED
    this.emit('close')
  }

  send(data: string): void {
    this.sent.push(data)
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.emit('open')
  }

  private emit(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn(new Event(type))
  }
}

describe('shouldForceResumeReconnect', () => {
  it('skips resume events that land inside the debounce window', () => {
    expect(shouldForceResumeReconnect(1_000, 0, 1500)).toBe(false)
    expect(shouldForceResumeReconnect(1_499, 0, 1500)).toBe(false)
  })

  it('forces a handshake after the debounce window (zombie OPEN)', () => {
    expect(shouldForceResumeReconnect(1_500, 0, 1500)).toBe(true)
    expect(shouldForceResumeReconnect(60_000, 1_000, 1500)).toBe(true)
  })
})

describe('openChatWs resume reconnect', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.useFakeTimers()
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  async function loadWs(): Promise<typeof import('./ws')> {
    return import('./ws')
  }

  it('does not reconnect when a resume event lands inside the debounce window', async () => {
    const { openChatWs } = await loadWs()
    const handle = openChatWs()
    MockWebSocket.instances[0]?.open()

    document.dispatchEvent(new Event('visibilitychange'))
    expect(MockWebSocket.instances.length).toBe(1)
    handle.close()
  })

  it('force-reconnects on visibility even when readyState is still OPEN', async () => {
    const { openChatWs } = await loadWs()
    const handle = openChatWs()
    const first = MockWebSocket.instances[0]
    expect(first).toBeDefined()
    first!.open()

    vi.advanceTimersByTime(WS_RESUME_DEBOUNCE_MS)
    document.dispatchEvent(new Event('visibilitychange'))

    expect(MockWebSocket.instances.length).toBe(2)
    expect(first!.readyState).toBe(MockWebSocket.CLOSED)
    const second = MockWebSocket.instances[1]
    expect(second).toBeDefined()
    second!.open()
    expect(handle.status()).toBe('open')
    handle.close()
  })

  it('debounces stacked visibility + agim-resume + pageshow', async () => {
    const { openChatWs } = await loadWs()
    const handle = openChatWs()
    MockWebSocket.instances[0]?.open()

    vi.advanceTimersByTime(WS_RESUME_DEBOUNCE_MS)
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('agim-resume'))
    window.dispatchEvent(new Event('pageshow'))

    expect(MockWebSocket.instances.length).toBe(2)
    handle.close()
  })

  it('native agim-resume after idle forces a new handshake', async () => {
    const { openChatWs } = await loadWs()
    const handle = openChatWs()
    MockWebSocket.instances[0]?.open()

    vi.advanceTimersByTime(WS_RESUME_DEBOUNCE_MS)
    window.dispatchEvent(new Event('agim-resume'))
    expect(MockWebSocket.instances.length).toBe(2)
    handle.close()
  })

  it('old socket close does not schedule a competing reconnect', async () => {
    const { openChatWs } = await loadWs()
    const handle = openChatWs()
    MockWebSocket.instances[0]?.open()

    vi.advanceTimersByTime(WS_RESUME_DEBOUNCE_MS)
    document.dispatchEvent(new Event('visibilitychange'))
    const afterForce = MockWebSocket.instances.length

    vi.advanceTimersByTime(30_000)
    expect(MockWebSocket.instances.length).toBe(afterForce)
    handle.close()
  })

  it('reconnect() handshakes immediately even inside the resume debounce', async () => {
    const { openChatWs } = await loadWs()
    const handle = openChatWs()
    MockWebSocket.instances[0]?.open()

    handle.reconnect()
    expect(MockWebSocket.instances.length).toBe(2)
    expect(MockWebSocket.instances[0]?.readyState).toBe(MockWebSocket.CLOSED)
    handle.close()
  })

  it('reconnectChatWs is a no-op before openChatWs and reconnects after', async () => {
    const mod = await loadWs()
    expect(() => mod.reconnectChatWs()).not.toThrow()
    const handle = mod.openChatWs()
    MockWebSocket.instances[0]?.open()
    mod.reconnectChatWs()
    expect(MockWebSocket.instances.length).toBe(2)
    handle.close()
  })
})
