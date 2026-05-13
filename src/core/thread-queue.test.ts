import { describe, it, expect, beforeEach } from 'bun:test'
import { runOnThread, getQueueDepth, _resetThreadQueues } from './thread-queue.js'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('thread-queue', () => {
  beforeEach(() => {
    _resetThreadQueues()
  })

  it('serializes same-key calls in FIFO order', async () => {
    const order: number[] = []
    const a = runOnThread('k', async () => {
      await delay(20)
      order.push(1)
      return 1
    })
    const b = runOnThread('k', async () => {
      order.push(2)
      return 2
    })
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toBe(1)
    expect(rb).toBe(2)
    expect(order).toEqual([1, 2])
  })

  it('different keys run in parallel', async () => {
    let aRunning = false
    let observed = false
    const a = runOnThread('k1', async () => {
      aRunning = true
      await delay(30)
      aRunning = false
    })
    // Start b while a is still running.
    await delay(5)
    const b = runOnThread('k2', async () => {
      observed = aRunning
    })
    await Promise.all([a, b])
    expect(observed).toBe(true)
  })

  it('predecessor failure does not poison waiters', async () => {
    const failing = runOnThread('k', async () => {
      throw new Error('boom')
    })
    const succeeding = runOnThread('k', async () => 'ok')
    await expect(failing).rejects.toThrow('boom')
    await expect(succeeding).resolves.toBe('ok')
  })

  it('fires onQueued with ahead count when something is in flight', async () => {
    const seen: number[] = []
    const a = runOnThread('k', async () => {
      await delay(20)
    })
    // Allow `a` to register itself as in-flight (depth = 1) before we
    // join — otherwise our depth read could race past it.
    await delay(2)
    const b = runOnThread('k', async () => 'b', {
      onQueued: (ahead) => { seen.push(ahead) },
    })
    await Promise.all([a, b])
    expect(seen).toEqual([1])
  })

  it('depth returns to zero after all calls drain', async () => {
    const a = runOnThread('k', async () => { await delay(15) })
    const b = runOnThread('k', async () => { await delay(15) })
    expect(getQueueDepth('k')).toBeGreaterThan(0)
    await Promise.all([a, b])
    expect(getQueueDepth('k')).toBe(0)
  })

  it('first caller never sees onQueued', async () => {
    let fired = false
    await runOnThread('k', async () => 'x', {
      onQueued: () => { fired = true },
    })
    expect(fired).toBe(false)
  })
})
