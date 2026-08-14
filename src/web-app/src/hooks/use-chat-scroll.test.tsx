/**
 * useChatFollowBottom — must not yank the viewport to the end while the
 * user is reading older history, even if the assistant is still streaming
 * or tool-activity steps keep growing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { createRef } from 'react'
import { CHAT_NEAR_BOTTOM_PX, useChatFollowBottom } from './use-chat-scroll'

function mountScroller(opts: {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () => opts.scrollHeight,
  })
  Object.defineProperty(el, 'clientHeight', {
    configurable: true,
    get: () => opts.clientHeight,
  })
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => opts.scrollTop,
    set: (v: number) => { opts.scrollTop = v },
  })
  el.scrollTo = ((arg?: ScrollToOptions | number) => {
    if (typeof arg === 'number') opts.scrollTop = arg
    else if (arg && typeof arg === 'object' && typeof arg.top === 'number') {
      opts.scrollTop = arg.top
    }
  }) as typeof el.scrollTo
  document.body.appendChild(el)
  return el
}

describe('useChatFollowBottom', () => {
  let now = 0

  beforeEach(() => {
    now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
  })
  afterEach(() => {
    document.body.replaceChildren()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('follows the bottom while the user stays near it during streaming', () => {
    const metrics = { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 }
    const el = mountScroller(metrics)
    const listRef = createRef<HTMLElement>()
    // @ts-expect-error test assigns the live node
    listRef.current = el

    const { rerender } = renderHook(
      (props) => useChatFollowBottom(props),
      {
        initialProps: {
          listRef,
          messageCount: 2,
          latestMessageContent: 'hi',
          streaming: true,
          followSignal: 0,
        },
      },
    )

    metrics.scrollHeight = 1200
    // Still within near-bottom threshold after growth if we were following
    // and the previous scrollToEnd landed us at the end.
    metrics.scrollTop = 1200 - 400
    el.dispatchEvent(new Event('scroll'))

    rerender({
      listRef,
      messageCount: 2,
      latestMessageContent: 'hi there',
      streaming: true,
      followSignal: 1,
    })

    expect(metrics.scrollTop).toBe(metrics.scrollHeight)
  })

  it('does not force scroll when the user has scrolled up during streaming', () => {
    const metrics = {
      scrollHeight: 2000,
      clientHeight: 400,
      // Well above the near-bottom threshold.
      scrollTop: 200,
    }
    const el = mountScroller(metrics)
    const listRef = createRef<HTMLElement>()
    // @ts-expect-error test assigns the live node
    listRef.current = el

    const { rerender } = renderHook(
      (props) => useChatFollowBottom(props),
      {
        initialProps: {
          listRef,
          messageCount: 3,
          latestMessageContent: 'partial',
          streaming: true,
          followSignal: 1,
          threadKey: 'web-a',
        },
      },
    )

    act(() => { vi.advanceTimersByTime(80) })
    now = 1000
    metrics.scrollTop = 200
    const scrolledUpTop = metrics.scrollTop
    // Latch "not following" from the scrolled-up geometry.
    el.dispatchEvent(new Event('scroll'))
    expect(metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight)
      .toBeGreaterThan(CHAT_NEAR_BOTTOM_PX)

    metrics.scrollHeight = 2600
    rerender({
      listRef,
      messageCount: 3,
      latestMessageContent: 'partial… tool done',
      streaming: true,
      followSignal: 4,
      threadKey: 'web-a',
    })

    expect(metrics.scrollTop).toBe(scrolledUpTop)
  })

  it('stickToBottom re-enables follow and jumps to the end', () => {
    const metrics = {
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTop: 100,
    }
    const el = mountScroller(metrics)
    const listRef = createRef<HTMLElement>()
    // @ts-expect-error test assigns the live node
    listRef.current = el

    const { result, rerender } = renderHook(
      (props) => useChatFollowBottom(props),
      {
        initialProps: {
          listRef,
          messageCount: 1,
          latestMessageContent: 'old',
          streaming: false,
          followSignal: 0,
        },
      },
    )

    el.dispatchEvent(new Event('scroll'))
    act(() => {
      result.current.stickToBottom()
    })
    expect(metrics.scrollTop).toBe(metrics.scrollHeight)

    metrics.scrollHeight = 2400
    rerender({
      listRef,
      messageCount: 2,
      latestMessageContent: 'new',
      streaming: true,
      followSignal: 0,
    })
    expect(metrics.scrollTop).toBe(metrics.scrollHeight)
  })

  it('re-pins to the latest message when the thread changes', () => {
    const metrics = {
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTop: 80,
    }
    const el = mountScroller(metrics)
    const listRef = createRef<HTMLElement>()
    // @ts-expect-error test assigns the live node
    listRef.current = el

    const { result, rerender } = renderHook(
      (props) => useChatFollowBottom(props),
      {
        initialProps: {
          listRef,
          messageCount: 4,
          latestMessageContent: 'old thread',
          streaming: false,
          followSignal: 0,
          threadKey: 'web-a',
        },
      },
    )

    act(() => { vi.advanceTimersByTime(80) })
    now = 1000
    metrics.scrollTop = 80
    act(() => { el.dispatchEvent(new Event('scroll')) })
    expect(result.current.showJumpToLatest).toBe(true)

    metrics.scrollHeight = 3200
    rerender({
      listRef,
      messageCount: 12,
      latestMessageContent: 'new thread latest',
      streaming: false,
      followSignal: 0,
      threadKey: 'web-b',
    })
    act(() => { vi.advanceTimersByTime(80) })

    expect(metrics.scrollTop).toBe(metrics.scrollHeight)
    expect(result.current.showJumpToLatest).toBe(false)
  })
})
