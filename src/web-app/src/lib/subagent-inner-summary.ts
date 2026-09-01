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

const HEARTBEAT_LINE_MAX = 56

export function formatHeartbeatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${s}s`
}

export function inferSubagentPhase(
  lastTool?: { label?: string; status?: string },
): 'tool' | 'idle' | 'running' {
  if (lastTool?.status === 'running' || lastTool?.status === 'pending') return 'tool'
  if (lastTool?.label) return 'idle'
  return 'running'
}

/** Always-visible liveness line: phase · callee · lastTool · wait. */
export function formatSubagentHeartbeatLine(input: {
  zh: boolean
  label: string
  lastTool?: { label: string; status?: string; at: number }
  startedAt: number
  heartbeatAt?: number
  now: number
}): string {
  const phase = inferSubagentPhase(input.lastTool)
  const phaseText = input.zh
    ? (phase === 'tool' ? '执行工具' : phase === 'idle' ? '等待下一步' : '运行中')
    : (phase === 'tool' ? 'in tool' : phase === 'idle' ? 'between tools' : 'running')
  const name = clipInnerSnippet((input.label || '').trim() || (input.zh ? '子任务' : 'subagent'), 16)
  const tool = input.lastTool?.label ? shortInnerToolLabel(input.lastTool.label) : ''
  const waited = formatHeartbeatElapsed(Math.max(0, input.now - input.startedAt))
  const parts = [
    phaseText,
    name,
    tool,
    input.zh ? `已等 ${waited}` : waited,
  ]
  if (input.lastTool?.at) {
    const age = formatHeartbeatElapsed(Math.max(0, input.now - input.lastTool.at))
    parts.push(input.zh ? `上次工具 ${age}` : `last tool ${age}`)
  } else if (typeof input.heartbeatAt === 'number') {
    const pulse = formatHeartbeatElapsed(Math.max(0, input.now - input.heartbeatAt))
    parts.push(input.zh ? `心跳 ${pulse}` : `pulse ${pulse}`)
  }
  return clipInnerSnippet(parts.filter(Boolean).join(' · '), HEARTBEAT_LINE_MAX)
}
