import { describe, it, expect } from 'bun:test'
import { createSerialQueue } from '../../src/web/server'

describe('web serial queue', () => {
  it('runs enqueued handlers one at a time in order', async () => {
    const enqueue = createSerialQueue()
    const events: string[] = []
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    enqueue(async () => {
      events.push('first:start')
      await firstBlocked
      events.push('first:end')
    })
    enqueue(async () => {
      events.push('second:start')
      events.push('second:end')
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    releaseFirst()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })
})

// v1.2.114 regression — `approval-action` MUST bypass enqueueInbound.
//
// Pre-fix shape (verbatim from web/server.ts:1220-1303):
//
//   ws.on('message', (data) => {
//     enqueueInbound(async () => {
//       const msg = JSON.parse(...)
//       if (msg.type === 'approval-action') { ...handle... return }
//       await handleClientMessage(...)
//     })
//   })
//
// → a chat message that runs an agent for 30 minutes (handleClientMessage
//   doesn't return until agent.invoke.end) blocks the queue, so a click
//   arriving while the agent runs sits behind it. The agent is waiting
//   for that click → deadlock until the 30-min hard timeout aborts the
//   agent.
//
// Post-fix shape:
//
//   ws.on('message', (data) => {
//     const msg = JSON.parse(...)
//     if (msg.type === 'approval-action') { void handleApprovalAction(msg); return }
//     enqueueInbound(async () => { await handleClientMessage(...) })
//   })
//
// → approval-action dispatches inline; chat keeps its FIFO queue.
describe('web serial queue — approval-action bypass (v1.2.114)', () => {
  // Reproduce the dispatch pattern. Real ws.on('message') would hand
  // each parsed frame here; we drive frames manually.
  function makeDispatcher() {
    const enqueue = createSerialQueue()
    const events: string[] = []
    const clickCallsBeforeChatEnd: number[] = []
    let chatRunning = false

    async function handleChatMessage(): Promise<void> {
      chatRunning = true
      events.push('chat:start')
      // Simulate an agent run blocked on user approval.
      await new Promise((r) => setTimeout(r, 80))
      events.push('chat:end')
      chatRunning = false
    }
    async function handleClick(label: string): Promise<void> {
      // Capture whether the click runs while chat is still in flight.
      // Pre-fix: this would always be false (clicks queued behind chat).
      // Post-fix: this is true (clicks bypass the queue).
      clickCallsBeforeChatEnd.push(chatRunning ? 1 : 0)
      events.push(`click:${label}`)
    }

    function dispatch(msg: { type: string; label?: string }): void {
      if (msg.type === 'approval-action') {
        void handleClick(msg.label ?? '')
        return
      }
      enqueue(async () => { await handleChatMessage() })
    }
    return { dispatch, events, clickCallsBeforeChatEnd }
  }

  it('approval-action runs while a slow chat handler is still in the queue', async () => {
    const d = makeDispatcher()
    d.dispatch({ type: 'message', label: 'hi' })       // slow chat queued

    // Let the queue's microtask-scheduled chat handler actually start
    // (it's only synchronously enqueued by dispatch; it runs on the
    // next microtask). In the real WS loop, frames arrive separated
    // by network time, so chat has always started by the time a click
    // arrives.
    await new Promise((r) => setTimeout(r, 1))
    expect(d.events).toEqual(['chat:start'])

    d.dispatch({ type: 'approval-action', label: 'a' }) // click — must bypass
    d.dispatch({ type: 'approval-action', label: 'b' })

    // Microtask tick → clicks executed inline (no enqueueInbound wait).
    await new Promise((r) => setTimeout(r, 1))
    expect(d.events).toContain('click:a')
    expect(d.events).toContain('click:b')
    expect(d.events).not.toContain('chat:end')
    // Both clicks observed chat as still running — confirms the bypass.
    expect(d.clickCallsBeforeChatEnd).toEqual([1, 1])

    // Wait for chat to finish; queue drains naturally.
    await new Promise((r) => setTimeout(r, 120))
    expect(d.events).toContain('chat:end')
  })

  it('chat-type messages still serialise vs each other', async () => {
    const d = makeDispatcher()
    d.dispatch({ type: 'message' })
    d.dispatch({ type: 'message' })
    await new Promise((r) => setTimeout(r, 200))
    // Two chat handlers each took ~80ms; total ~160ms confirms serial.
    expect(d.events).toEqual(['chat:start', 'chat:end', 'chat:start', 'chat:end'])
  })
})

// Portal Stop — `{ type: 'stop' }` must abort while chat is in flight.
// Same deadlock class as approval-action: stop used to sit behind
// handleClientMessage until the agent finished, then replied
// "当前没有正在执行的任务".
describe('web serial queue — stop bypass', () => {
  function makeDispatcher() {
    const enqueue = createSerialQueue()
    const events: string[] = []
    let chatRunning = false
    let abortedWhileChatRunning = false

    async function handleChatMessage(): Promise<void> {
      chatRunning = true
      events.push('chat:start')
      await new Promise((r) => setTimeout(r, 80))
      events.push('chat:end')
      chatRunning = false
    }

    function handleStop(): void {
      abortedWhileChatRunning = chatRunning
      events.push('stop')
    }

    function dispatch(msg: { type: string }): void {
      if (msg.type === 'stop') {
        handleStop()
        return
      }
      enqueue(async () => { await handleChatMessage() })
    }

    return { dispatch, events, get abortedWhileChatRunning() { return abortedWhileChatRunning } }
  }

  it('stop runs while a slow chat handler is still in the queue', async () => {
    const d = makeDispatcher()
    d.dispatch({ type: 'message' })
    await new Promise((r) => setTimeout(r, 1))
    expect(d.events).toEqual(['chat:start'])

    d.dispatch({ type: 'stop' })
    await new Promise((r) => setTimeout(r, 1))
    expect(d.events).toContain('stop')
    expect(d.events).not.toContain('chat:end')
    expect(d.abortedWhileChatRunning).toBe(true)

    await new Promise((r) => setTimeout(r, 120))
    expect(d.events).toContain('chat:end')
  })
})
