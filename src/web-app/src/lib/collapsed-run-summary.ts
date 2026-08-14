/**
 * One-line collapsed run bar: latest thinking + latest tool/skill.
 * Keep it short so the portal “执行中” chip stays a single row.
 */

import type { ChatActivity } from '@/hooks/use-chat'

const THINK_MAX = 22
const TOOL_MAX = 14
const LINE_MAX = 42

export function clipActivitySnippet(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/** `mcp__agim__read_skill` / `agim_exec` → `read_skill` / `exec`. */
export function shortActivityToolLabel(label: string): string {
  let name = (label || '').trim()
  if (!name) return ''
  if (name.includes('__')) name = name.split('__').pop() || name
  name = name.replace(/^(agim_|native_|mcp_)/, '')
  return clipActivitySnippet(name, TOOL_MAX)
}

/** Empty when there is nothing useful yet (caller keeps “Running…”). */
export function formatCollapsedRunSummary(activity: ChatActivity): string {
  const reflect = [...activity.steps].reverse().find((s) => s.kind === 'reflect')
  const think = clipActivitySnippet(reflect?.label || reflect?.preview || '', THINK_MAX)
  const toolStep = [...activity.steps].reverse().find((s) => (
    s.kind === 'tool' || s.kind === 'skill' || s.kind === 'agent'
  ))
  let tool = ''
  if (toolStep?.kind === 'agent') {
    tool = clipActivitySnippet(toolStep.label, TOOL_MAX)
  } else if (toolStep) {
    tool = shortActivityToolLabel(toolStep.label)
  }
  const parts = [think, tool].filter(Boolean)
  if (parts.length === 0) return ''
  return clipActivitySnippet(parts.join(' · '), LINE_MAX)
}
