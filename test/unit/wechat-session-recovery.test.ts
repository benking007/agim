// CR H3 — WeChat SESSION_EXPIRED recovery must not drop the recovery batch.
//
// tryRefreshSession() calls getUpdates('') which consumes the server-side
// cursor; previously it only stashed each msg's context_token and never
// dispatched, so any messages returned during recovery were lost forever.
// This locks that the recovery batch is routed through handleIncomingMessage
// (the same path the main poll loop uses), while the cursor is still updated.

import { describe, it, expect } from 'bun:test'
import { ILinkWeChatAdapter } from '../../src/plugins/messengers/wechat/ilink-adapter.js'
import type { WeixinMessage } from '../../src/plugins/messengers/wechat/ilink-types.js'

function msg(id: number, from: string, token: string): WeixinMessage {
  return {
    message_id: id,
    message_type: 1,
    from_user_id: from,
    context_token: token,
    item_list: [{ type: 1, content: `hi ${id}` }],
  } as unknown as WeixinMessage
}

describe('ILinkWeChatAdapter — SESSION_EXPIRED recovery (H3)', () => {
  it('dispatches the recovery batch through handleIncomingMessage and advances the cursor', async () => {
    const adapter = new ILinkWeChatAdapter()
    const recovered = [msg(101, 'u1', 'tok-1'), msg(102, 'u2', 'tok-2')]

    // Inject a stub client whose getUpdates('') returns a recovery batch.
    ;(adapter as unknown as { client: unknown }).client = {
      getUpdates: async (_buf: string) => ({ ret: 0, get_updates_buf: 'cursor-after-recovery', msgs: recovered }),
    }

    // Spy on the private dispatch path (the exact thing the fix wires up).
    const dispatched: number[] = []
    ;(adapter as unknown as { handleIncomingMessage: (m: WeixinMessage) => Promise<void> }).handleIncomingMessage =
      async (m: WeixinMessage) => { dispatched.push(m.message_id as number) }

    const ok = await (adapter as unknown as { tryRefreshSession: () => Promise<boolean> }).tryRefreshSession()
    // Let the fire-and-forget dispatches settle.
    await new Promise((r) => setTimeout(r, 0))

    expect(ok).toBe(true)
    expect(dispatched.sort()).toEqual([101, 102])
    // Cursor advanced to the recovery response's buffer.
    expect((adapter as unknown as { pollState: { getUpdatesBuf: string } }).pollState.getUpdatesBuf)
      .toBe('cursor-after-recovery')
    // Context tokens captured for replies.
    const tok = (adapter as unknown as { getContextToken?: (u: string) => string | undefined }).getContextToken
    if (typeof tok === 'function') {
      expect(tok.call(adapter, 'u1')).toBe('tok-1')
    }
  })
})
