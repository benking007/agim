import { describe, expect, it } from 'bun:test'
import {
  expandInlineChannelReply,
  needsFullInlineDelivery,
  resolveArchivedMarkdownPath,
} from './inline-delivery.js'

describe('needsFullInlineDelivery', () => {
  it('is true for web / tui (Portal + macOS shell use platform=web)', () => {
    expect(needsFullInlineDelivery('web')).toBe(true)
    expect(needsFullInlineDelivery('tui')).toBe(true)
  })

  it('is false for IM messengers', () => {
    expect(needsFullInlineDelivery('wechat')).toBe(false)
    expect(needsFullInlineDelivery('telegram')).toBe(false)
    expect(needsFullInlineDelivery('feishu')).toBe(false)
  })
})

describe('expandInlineChannelReply', () => {
  it('unwraps im-summary envelope to full-md', () => {
    const text = [
      '<im-summary>短要点</im-summary>',
      '<full-md>',
      '# 完整报告',
      '',
      '很长的正文……',
      '</full-md>',
    ].join('\n')
    expect(expandInlineChannelReply(text)).toContain('# 完整报告')
    expect(expandInlineChannelReply(text)).not.toContain('<im-summary>')
  })

  it('appends archived markdown when chat is a short digest', () => {
    const fileBody = [
      '# 持仓调整计划',
      '',
      '详细分析段落一。'.repeat(40),
      '',
      '详细分析段落二。'.repeat(40),
    ].join('\n')
    const chat = '报告已落盘：docs/portfolio-review-20260723.md。以下是核心结论。\n\n有色领涨。'
    const out = expandInlineChannelReply(chat, {
      workspaceRoot: '/tmp/agim-ws',
      readFile: (abs) => {
        expect(abs).toContain('docs/portfolio-review-20260723.md')
        return fileBody
      },
    })
    expect(out).toContain('报告已落盘')
    expect(out).toContain('# 持仓调整计划')
    expect(out).toContain('详细分析段落一')
  })

  it('does not expand when file content is already in the chat', () => {
    const fileBody = '# Already here\n\n' + 'x'.repeat(500)
    const chat = `报告已落盘：docs/a.md\n\n${fileBody}`
    const out = expandInlineChannelReply(chat, {
      workspaceRoot: '/tmp/agim-ws',
      readFile: () => fileBody,
    })
    expect(out).toBe(chat)
  })

  it('rejects path traversal', () => {
    expect(resolveArchivedMarkdownPath('/tmp/ws', '../etc/passwd.md')).toBeNull()
    expect(resolveArchivedMarkdownPath('/tmp/ws', '/etc/passwd.md')).toBeNull()
  })

  it('preserves ordinary long replies byte-for-byte (no trim side effects)', () => {
    const long = `# Report\n\n${'paragraph '.repeat(80)}`
    expect(expandInlineChannelReply(long, { workspaceRoot: '/tmp/ws' })).toBe(long)
  })
})
