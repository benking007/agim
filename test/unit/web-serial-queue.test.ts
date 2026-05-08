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
