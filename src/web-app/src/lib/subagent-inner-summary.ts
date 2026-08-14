/** One-line inner status for a live Subagent card (think · tool). */

export interface SubagentInnerStep {
  reflects?: Array<{ next: string }>
  lastTool?: { label: string; status?: string }
}

const THINK_MAX = 22
const TOOL_MAX = 14
const LINE_MAX = 42

export function clipInnerSnippet(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  if (compact.length <= max) return compact
  return `${compact.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/** `mcp__agim__read_skill` / `agim_exec` → `read_skill` / `exec`. */
export function shortInnerToolLabel(label: string): string {
  let name = (label || '').trim()
  if (!name) return ''
  if (name.includes('__')) name = name.split('__').pop() || name
  name = name.replace(/^(agim_|native_|mcp_)/, '')
  return clipInnerSnippet(name, TOOL_MAX)
}

/** Empty when there is nothing useful yet (caller keeps “Thinking…”). */
export function formatSubagentInnerSummary(step: SubagentInnerStep): string {
  const think = clipInnerSnippet(step.reflects?.at(-1)?.next ?? '', THINK_MAX)
  const tool = step.lastTool?.label ? shortInnerToolLabel(step.lastTool.label) : ''
  const parts = [think, tool].filter(Boolean)
  if (parts.length === 0) return ''
  return clipInnerSnippet(parts.join(' · '), LINE_MAX)
}
