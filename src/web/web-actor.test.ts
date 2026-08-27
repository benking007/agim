import { describe, expect, it } from 'bun:test'
import { webChatActorUserId } from './web-actor.js'

describe('webChatActorUserId', () => {
  it('uses the logged-in account id so plan-exit clicks match the pending', () => {
    expect(webChatActorUserId('usr_alice', 'web-threadbbbb')).toBe('usr_alice')
  })

  it('falls back to web:<threadId> for anonymous sessions', () => {
    expect(webChatActorUserId(undefined, 'web-threadbbbb')).toBe('web:web-threadbbbb')
    expect(webChatActorUserId('  ', 'web-threadbbbb')).toBe('web:web-threadbbbb')
  })
})
