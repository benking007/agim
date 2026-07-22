/**
 * Approximate Context Usage buckets (Cursor-aligned labels).
 * Sizes are heuristics until a measured backend snapshot exists.
 */

import type { ChatMessage } from '@/hooks/use-chat'

export interface BreakdownBucket {
  key: string
  /** Stable i18n / label id */
  labelKey:
    | 'system'
    | 'tools'
    | 'rules'
    | 'skills'
    | 'mcp'
    | 'subagents'
    | 'summarized'
    | 'conversation'
  tokens: number
  color: string
}

/** Base system framing (discipline + runtime + guidance), excluding rules/skills. */
export const EST_SYSTEM_BASE_TOKENS = 600
/** Native Agim Agent ToolDef JSON ≈ measured ~4.8k tokens. */
export const EST_NATIVE_TOOL_DEF_TOKENS = 4_800
/** Rough per-external-MCP-tool schema size. */
export const EST_MCP_TOOL_TOKENS = 350
/** call_agent / verification SOP crumbs folded out of system. */
export const EST_SUBAGENT_TOKENS = 120

export const BREAKDOWN_COLORS: Record<BreakdownBucket['labelKey'], string> = {
  system: '#a1a1aa',
  tools: '#a78bfa',
  rules: '#4ade80',
  skills: '#ca8a04',
  mcp: '#e879f9',
  subagents: '#60a5fa',
  summarized: '#be123c',
  conversation: '#ef4444',
}

export function tokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0
  return Math.max(0, Math.ceil(chars / 4))
}

/** Sum user + assistant bubble text (web history; excludes live tool payloads). */
export function estimateConversationTokens(messages: ChatMessage[]): {
  conversation: number
  user: number
  assistant: number
} {
  let user = 0
  let assistant = 0
  for (const m of messages) {
    const n = tokensFromChars((m.content || '').length)
    if (m.role === 'user') user += n
    else if (m.role === 'assistant') assistant += n
    else user += n
  }
  return { conversation: user + assistant, user, assistant }
}

/**
 * Best-effort "summarized conversation" size from compaction activity previews.
 * Prefer explicit summary≈N; else fall back to a small fraction of tokensBefore.
 */
export function estimateSummarizedTokens(messages: ChatMessage[]): number {
  let best = 0
  for (const m of messages) {
    const steps = m.activity?.steps
    if (!steps) continue
    for (const step of steps) {
      if (step.kind !== 'status') continue
      if (step.label !== 'Compacting context') continue
      if (step.status !== 'success') continue
      const preview = step.preview || ''
      const summaryMatch = preview.match(/summary(?:Tokens)?≈(\d+)/i)
      if (summaryMatch?.[1]) {
        best = Math.max(best, Number.parseInt(summaryMatch[1], 10) || 0)
        continue
      }
      const beforeMatch = preview.match(/tokensBefore≈(\d+)/i)
      if (beforeMatch?.[1]) {
        const before = Number.parseInt(beforeMatch[1], 10) || 0
        // Compaction summaries are typically a few percent of pre-compact size.
        best = Math.max(best, Math.max(200, Math.floor(before * 0.04)))
      }
    }
  }
  return best
}

export interface BuildContextBreakdownInput {
  isAgim: boolean
  messages: ChatMessage[]
  /** Rules file chars (AGENTS.md + local + MEMORY.md). */
  rulesChars?: number
  /** Skills injection chars (override or auto). */
  skillsChars?: number
  /** External MCP tool count (admin API; optional). */
  mcpToolCount?: number
}

export function buildContextBreakdown(input: BuildContextBreakdownInput): BreakdownBucket[] {
  const { conversation } = estimateConversationTokens(input.messages)
  if (!input.isAgim) {
    return [
      {
        key: 'system',
        labelKey: 'system',
        tokens: 400,
        color: BREAKDOWN_COLORS.system,
      },
      {
        key: 'conversation',
        labelKey: 'conversation',
        tokens: conversation,
        color: BREAKDOWN_COLORS.conversation,
      },
    ]
  }

  const rules = tokensFromChars(input.rulesChars ?? 0)
  const skills = tokensFromChars(input.skillsChars ?? 0)
  const mcpTools = Math.max(0, input.mcpToolCount ?? 0)
  const mcp = mcpTools > 0 ? mcpTools * EST_MCP_TOOL_TOKENS : 0
  const summarized = estimateSummarizedTokens(input.messages)

  const buckets: BreakdownBucket[] = [
    {
      key: 'system',
      labelKey: 'system',
      tokens: EST_SYSTEM_BASE_TOKENS,
      color: BREAKDOWN_COLORS.system,
    },
    {
      key: 'tools',
      labelKey: 'tools',
      tokens: EST_NATIVE_TOOL_DEF_TOKENS,
      color: BREAKDOWN_COLORS.tools,
    },
    {
      key: 'rules',
      labelKey: 'rules',
      tokens: rules,
      color: BREAKDOWN_COLORS.rules,
    },
    {
      key: 'skills',
      labelKey: 'skills',
      tokens: skills,
      color: BREAKDOWN_COLORS.skills,
    },
    {
      key: 'mcp',
      labelKey: 'mcp',
      tokens: mcp,
      color: BREAKDOWN_COLORS.mcp,
    },
    {
      key: 'subagents',
      labelKey: 'subagents',
      tokens: EST_SUBAGENT_TOKENS,
      color: BREAKDOWN_COLORS.subagents,
    },
    {
      key: 'summarized',
      labelKey: 'summarized',
      tokens: summarized,
      color: BREAKDOWN_COLORS.summarized,
    },
    {
      key: 'conversation',
      labelKey: 'conversation',
      tokens: conversation,
      color: BREAKDOWN_COLORS.conversation,
    },
  ]
  return buckets.filter((b) => b.tokens > 0)
}

export function sumBreakdownTokens(buckets: BreakdownBucket[]): number {
  return buckets.reduce((n, b) => n + b.tokens, 0)
}
