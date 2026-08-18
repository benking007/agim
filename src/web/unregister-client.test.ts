import { describe, expect, it } from 'bun:test'
import { unregisterClientIfCurrent } from './unregister-client.js'

describe('unregisterClientIfCurrent', () => {
  it('deletes only when the map still holds this client', () => {
    const a = { id: 'a' }
    const b = { id: 'b' }
    const clients = new Map<string, { id: string }>([['t1', a]])

    expect(unregisterClientIfCurrent(clients, 't1', a)).toBe(true)
    expect(clients.has('t1')).toBe(false)
  })

  it('does not delete a rekeyed peer under the same threadId', () => {
    const oldConn = { id: 'old' }
    const newConn = { id: 'new' }
    const clients = new Map<string, { id: string }>([['thread-1', newConn]])

    // Old socket closes after reconnect rekeyed thread-1 → newConn.
    expect(unregisterClientIfCurrent(clients, 'thread-1', oldConn)).toBe(false)
    expect(clients.get('thread-1')).toBe(newConn)
  })
})
