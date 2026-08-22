import { describe, expect, it } from 'bun:test'
import { WebSocket } from 'ws'
import { wsCanDeliver } from '../../src/web/ws-chat.js'

describe('wsCanDeliver', () => {
  it('rejects sockets that are not OPEN', () => {
    const ws = { readyState: 0, OPEN: 1 } as unknown as WebSocket
    expect(wsCanDeliver(ws)).toBe(false)
  })

  it('rejects half-open OPEN sockets (isAlive === false)', () => {
    const ws = { readyState: 1, OPEN: 1, isAlive: false } as unknown as WebSocket
    expect(wsCanDeliver(ws)).toBe(false)
  })

  it('accepts OPEN sockets that are still alive or unmarked', () => {
    const alive = { readyState: 1, OPEN: 1, isAlive: true } as unknown as WebSocket
    const unmarked = { readyState: 1, OPEN: 1 } as unknown as WebSocket
    expect(wsCanDeliver(alive)).toBe(true)
    expect(wsCanDeliver(unmarked)).toBe(true)
  })
})
