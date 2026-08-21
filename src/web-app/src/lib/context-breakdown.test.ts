import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@/hooks/use-chat'
import {
  EST_NATIVE_TOOL_DEF_TOKENS,
  EST_SYSTEM_BASE_TOKENS,
  applyMeasuredContextTokens,
  buildContextBreakdown,
  estimateConversationTokens,
  estimateSummarizedTokens,
  resolveContextUsedTokens,
  sumBreakdownTokens,
} from './context-breakdown'

function msg(
  role: ChatMessage['role'],
  content: string,
  activity?: ChatMessage['activity'],
): ChatMessage {
  return {
    id: `${role}-${content.slice(0, 8)}`,
    role,
    content,
    timestamp: Date.now(),
    activity,
  }
}

describe('context-breakdown', () => {
  it('splits user/assistant conversation tokens', () => {
    const messages = [
      msg('user', 'a'.repeat(400)),
      msg('assistant', 'b'.repeat(800)),
    ]
    const { user, assistant, conversation } = estimateConversationTokens(messages)
    expect(user).toBe(100)
    expect(assistant).toBe(200)
    expect(conversation).toBe(300)
  })

  it('builds Cursor-like buckets for Agim', () => {
    const buckets = buildContextBreakdown({
      isAgim: true,
      messages: [msg('user', 'hello world')],
      rulesChars: 400,
      skillsChars: 800,
      mcpToolCount: 2,
    })
    const keys = buckets.map((b) => b.key)
    expect(keys).toContain('system')
    expect(keys).toContain('tools')
    expect(keys).toContain('rules')
    expect(keys).toContain('skills')
    expect(keys).toContain('mcp')
    expect(keys).toContain('subagents')
    expect(keys).toContain('conversation')
    expect(buckets.find((b) => b.key === 'system')?.tokens).toBe(EST_SYSTEM_BASE_TOKENS)
    expect(buckets.find((b) => b.key === 'tools')?.tokens).toBe(EST_NATIVE_TOOL_DEF_TOKENS)
    expect(sumBreakdownTokens(buckets)).toBeGreaterThan(EST_NATIVE_TOOL_DEF_TOKENS)
  })

  it('estimates summarized tokens from compaction activity preview', () => {
    const messages = [
      msg('assistant', 'done', {
        runId: 'r1',
        status: 'success',
        startedAt: 1,
        steps: [{
          id: 'c1',
          kind: 'status',
          label: 'Compacting context',
          status: 'success',
          startedAt: 1,
          preview: 'mid-turn: tokensBefore≈10000',
        }],
      }),
    ]
    expect(estimateSummarizedTokens(messages)).toBe(400)
  })

  it('includes activity preview in conversation heuristic', () => {
    const messages = [
      msg('assistant', 'ok', {
        runId: 'r1',
        status: 'success',
        startedAt: 1,
        steps: [{
          id: 't1',
          kind: 'tool',
          label: 'read',
          status: 'success',
          startedAt: 1,
          preview: 'x'.repeat(400),
        }],
      }),
    ]
    const { conversation } = estimateConversationTokens(messages)
    expect(conversation).toBeGreaterThan(1) // "ok" alone is 1 token
    expect(conversation).toBeGreaterThanOrEqual(100)
  })

  it('applies measured context by expanding the conversation bucket', () => {
    const base = buildContextBreakdown({
      isAgim: true,
      messages: [msg('user', 'hi')],
      rulesChars: 0,
      skillsChars: 0,
    })
    const fixed = sumBreakdownTokens(base.filter((b) => b.labelKey !== 'conversation'))
    const measured = fixed + 50_000
    const next = applyMeasuredContextTokens(base, measured)
    expect(resolveContextUsedTokens(next, measured)).toBe(measured)
    expect(next.find((b) => b.labelKey === 'conversation')?.tokens).toBe(50_000)
  })
})
