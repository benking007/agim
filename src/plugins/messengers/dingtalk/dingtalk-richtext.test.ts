// v1.2.104 — DingTalk richText flattening across payload shapes.
//
// The headline case is the REAL Stream-SDK 1:1 payload captured in
// production (~/.agim/im-hub.log), where the segment array lives at
// `msg.content.richText` DIRECTLY (segments are `{ text: "…" }`, no
// `type` field) — not nested under `.msgList`. v1.2.90 only probed
// `.msgList`-suffixed locations, so this fell through to the
// "no extractable text" fallback. This test locks the fix.

import { describe, it, expect } from 'bun:test'
import { flattenDingtalkRichText } from './dingtalk-adapter'

describe('flattenDingtalkRichText', () => {
  it('extracts text from the real content.richText[] shape (v1.2.104)', () => {
    // Verbatim structure from the captured fullPayload.
    const msg = {
      msgtype: 'richText',
      msgId: 'msgTk6eCpSBTGGgM9oaPA293A==',
      content: {
        richText: [
          { text: '我要查询黄金基金定投数据，具体需求：' },
          { text: '\n' },
          { text: '• 最近七天的数据\n• 汇总的当前已有定投签约数、定投交易订单数、申购金额\n• 查询全部黄金基金产品\n• 注意分类不要搞错了，是：GOLD_FUND' },
          { text: '\n' },
        ],
      },
    }
    const r = flattenDingtalkRichText(msg as unknown as Record<string, unknown>)
    expect(r.source).toBe('msg.content.richText[]')
    expect(r.pictureCount).toBe(0)
    expect(r.textPartCount).toBe(2) // the two \n-only segments are dropped
    expect(r.text).toContain('我要查询黄金基金定投数据')
    expect(r.text).toContain('GOLD_FUND')
    // The two real text segments are joined by a newline.
    expect(r.text).toBe(
      '我要查询黄金基金定投数据，具体需求：\n• 最近七天的数据\n• 汇总的当前已有定投签约数、定投交易订单数、申购金额\n• 查询全部黄金基金产品\n• 注意分类不要搞错了，是：GOLD_FUND',
    )
  })

  it('extracts from msg.richText[] array-direct shape', () => {
    const msg = {
      msgtype: 'richText',
      richText: [{ text: 'hello' }, { text: 'world' }],
    }
    const r = flattenDingtalkRichText(msg as unknown as Record<string, unknown>)
    expect(r.source).toBe('msg.richText[]')
    expect(r.text).toBe('hello\nworld')
  })

  it('still handles legacy msg.richText.msgList shape', () => {
    const msg = {
      msgtype: 'richText',
      richText: { msgList: [{ type: 'text', text: 'legacy a' }, { type: 'text', text: 'legacy b' }] },
    }
    const r = flattenDingtalkRichText(msg as unknown as Record<string, unknown>)
    expect(r.source).toBe('msg.richText.msgList')
    expect(r.text).toBe('legacy a\nlegacy b')
  })

  it('still handles legacy msg.content.richText.msgList shape', () => {
    const msg = {
      msgtype: 'richText',
      content: { richText: { msgList: [{ type: 'text', text: 'c1' }] } },
    }
    const r = flattenDingtalkRichText(msg as unknown as Record<string, unknown>)
    expect(r.source).toBe('msg.content.richText.msgList')
    expect(r.text).toBe('c1')
  })

  it('counts picture segments and skips them in text', () => {
    const msg = {
      msgtype: 'richText',
      content: {
        richText: [
          { text: 'see this' },
          { type: 'picture', downloadCode: 'abc' },
          { type: 'picture', downloadCode: 'def' },
        ],
      },
    }
    const r = flattenDingtalkRichText(msg as unknown as Record<string, unknown>)
    expect(r.pictureCount).toBe(2)
    expect(r.text).toBe('see this')
  })

  it('tolerates `content` field name as text-segment body', () => {
    const msg = {
      msgtype: 'richText',
      richText: [{ content: 'via content field' }],
    }
    const r = flattenDingtalkRichText(msg as unknown as Record<string, unknown>)
    expect(r.text).toBe('via content field')
  })

  it('returns empty text + source "none" when no segment array found', () => {
    const msg = { msgtype: 'richText', somethingElse: 42 }
    const r = flattenDingtalkRichText(msg as unknown as Record<string, unknown>)
    expect(r.source).toBe('none')
    expect(r.text).toBe('')
    expect(r.listLen).toBe(0)
  })

  it('prefers array-direct over a same-level empty container', () => {
    // content.richText is a non-empty array → wins even though the
    // legacy probes would also be evaluated.
    const msg = {
      msgtype: 'richText',
      content: { richText: [{ text: 'win' }] },
    }
    const r = flattenDingtalkRichText(msg as unknown as Record<string, unknown>)
    expect(r.source).toBe('msg.content.richText[]')
    expect(r.text).toBe('win')
  })
})
