import type { AgentSendOpts } from '../../../core/types.js'

export type ReliabilityStatus = 'SUCCESS' | 'PARTIAL' | 'UNVERIFIED' | 'BLOCKED' | 'LIMITED' | 'FAILED'
export type ReliabilityKind = 'coding' | 'research' | 'investment' | 'planning' | 'general'
export type ReliabilityStopReason = 'max_iter' | 'stuck_loop' | null

export interface ReliabilityGoal {
  title: string
  body?: string
}

export interface ReliabilityEvidence {
  id: string
  kind: 'tool' | 'source' | 'verifier' | 'artifact' | 'blocker'
  ok: boolean
  source: string
  summary: string
}

export interface ReliabilityState {
  enabled: boolean
  kind: ReliabilityKind
  goal: string
  p0: string[]
  evidence: ReliabilityEvidence[]
}

export interface NativeToolResultLike {
  toolName?: string
  input?: unknown
  isError?: boolean
  content?: Array<{ type?: string; text?: string }>
  details?: unknown
}

export interface ReliabilityDelivery {
  status: ReliabilityStatus
  kind: ReliabilityKind
  reason: string
  evidence: ReliabilityEvidence[]
}

type ReliabilityMode = 'off' | 'auto' | 'always'

export function resolveReliabilityMode(raw = process.env.AGIM_RELIABILITY_LOOP): ReliabilityMode {
  const v = (raw ?? 'auto').toLowerCase().trim()
  if (v === 'off' || v === '0' || v === 'false' || v === 'no') return 'off'
  if (v === 'always' || v === 'on' || v === '1' || v === 'true') return 'always'
  return 'auto'
}

export function createReliabilityState(input: {
  prompt: string
  opts?: AgentSendOpts
  activeGoal?: ReliabilityGoal | null
  mode?: ReliabilityMode
}): ReliabilityState | null {
  const mode = input.mode ?? resolveReliabilityMode()
  if (mode === 'off') return null
  const kind = classifyReliabilityKind(input.prompt, input.activeGoal)
  const shouldEnable = mode === 'always'
    || !!input.activeGoal
    || input.opts?.planMode === true
    || kind !== 'general'
  if (!shouldEnable) return null
  const goal = input.activeGoal
    ? `${input.activeGoal.title}${input.activeGoal.body ? `\n${input.activeGoal.body}` : ''}`
    : input.prompt.trim()
  return {
    enabled: true,
    kind,
    goal,
    p0: buildP0(kind),
    evidence: [],
  }
}

export function recordReliabilityToolResult(
  state: ReliabilityState | null,
  ev: NativeToolResultLike,
): ReliabilityState | null {
  if (!state) return state
  const source = ev.toolName || 'unknown_tool'
  const ok = ev.isError !== true
  const summary = previewToolResult(ev)
  const kind = classifyEvidence(source, ev.input, summary, ok)
  return {
    ...state,
    evidence: [
      ...state.evidence,
      {
        id: `ev-${state.evidence.length + 1}`,
        kind,
        ok,
        source,
        summary,
      },
    ],
  }
}

export function deriveReliabilityDelivery(
  state: ReliabilityState,
  input: { finalText: string; stopReason: ReliabilityStopReason; maxIterations: number },
): ReliabilityDelivery {
  const finalText = input.finalText.trim()
  const hasText = finalText.length > 0
  const okEvidence = state.evidence.filter((e) => e.ok)
  const hasBlocker = state.evidence.some((e) => e.kind === 'blocker')
  const hasErrors = state.evidence.some((e) => !e.ok)

  if (input.stopReason === 'max_iter') {
    return {
      status: 'LIMITED',
      kind: state.kind,
      reason: `已达到最大迭代步数 ${input.maxIterations}，不能声明任务完成。`,
      evidence: state.evidence,
    }
  }
  if (input.stopReason === 'stuck_loop') {
    return {
      status: 'FAILED',
      kind: state.kind,
      reason: '检测到工具以相同参数/结果反复失败，已提前停止。',
      evidence: state.evidence,
    }
  }
  if (hasBlocker && !hasText) {
    return {
      status: 'BLOCKED',
      kind: state.kind,
      reason: '关键工具调用被策略或审批阻断，且没有可交付结果。',
      evidence: state.evidence,
    }
  }
  if (!hasText) {
    return {
      status: 'UNVERIFIED',
      kind: state.kind,
      reason: state.evidence.length > 0
        ? '有工具证据，但模型没有生成可见收尾内容。'
        : '本轮没有生成可见回复，也没有可用证据。',
      evidence: state.evidence,
    }
  }

  const p0Satisfied = satisfiesP0(state, finalText, okEvidence)
  if (!p0Satisfied) {
    return {
      status: hasBlocker ? 'BLOCKED' : 'UNVERIFIED',
      kind: state.kind,
      reason: missingP0Reason(state.kind),
      evidence: state.evidence,
    }
  }

  return {
    status: hasErrors ? 'PARTIAL' : 'SUCCESS',
    kind: state.kind,
    reason: hasErrors
      ? '核心交付条件已满足，但本轮仍存在失败/阻断证据，按部分完成处理。'
      : successReason(state.kind),
    evidence: state.evidence,
  }
}

export function formatReliabilityOutput(delivery: ReliabilityDelivery, text: string): string {
  const evidenceLine = formatEvidenceLine(delivery.evidence)
  const header = [
    `Status: ${delivery.status}`,
    `Reliability: ${delivery.reason}`,
    evidenceLine ? `Evidence: ${evidenceLine}` : undefined,
  ].filter(Boolean).join('\n')
  if (!text.trim()) return header
  return `${header}\n\n${text}`
}

function classifyReliabilityKind(prompt: string, goal?: ReliabilityGoal | null): ReliabilityKind {
  const text = `${prompt}\n${goal?.title ?? ''}\n${goal?.body ?? ''}`.toLowerCase()
  if (/(代码|编码|实现|修复|bug|测试|编译|构建|重构|仓库|提交|pr|typescript|javascript|node|lint|typecheck|test|build|fix|refactor|repo|code)/i.test(text)) {
    return 'coding'
  }
  if (/(投资|理财|资产配置|股票|基金|债券|估值|收益|回撤|组合|财务计划|investment|portfolio|stock|fund|valuation|drawdown)/i.test(text)) {
    return 'investment'
  }
  if (/(调研|研究|资料|来源|竞品|市场|行业|报告|文献|research|survey|source|market|competitor|literature)/i.test(text)) {
    return 'research'
  }
  if (/(方案|计划|规划|策略|路线图|proposal|plan|strategy|roadmap|design)/i.test(text)) {
    return 'planning'
  }
  return 'general'
}

function buildP0(kind: ReliabilityKind): string[] {
  switch (kind) {
    case 'coding':
      return ['Relevant verifier evidence exists: tests, typecheck, lint, or build passed.']
    case 'research':
      return ['Claims are backed by source/search/fetch evidence.']
    case 'investment':
      return ['Plan is source-backed and includes explicit risk/assumption framing.']
    case 'planning':
      return ['The plan/proposal is present and includes assumptions, risks, or next steps.']
    default:
      return ['A visible deliverable exists with supporting tool evidence.']
  }
}

function satisfiesP0(state: ReliabilityState, finalText: string, okEvidence: ReliabilityEvidence[]): boolean {
  switch (state.kind) {
    case 'coding':
      return okEvidence.some((e) => e.kind === 'verifier')
    case 'research':
      return okEvidence.some((e) => e.kind === 'source')
    case 'investment':
      return okEvidence.some((e) => e.kind === 'source') && hasRiskLanguage(finalText)
    case 'planning':
      return hasPlanStructure(finalText)
    default:
      return okEvidence.length > 0
  }
}

function classifyEvidence(
  toolName: string,
  input: unknown,
  summary: string,
  ok: boolean,
): ReliabilityEvidence['kind'] {
  const haystack = `${toolName}\n${safeJson(input)}\n${summary}`.toLowerCase()
  if (!ok && /(denied|blocked|requires approval|approval|policy|拒绝|阻断|审批|权限)/i.test(haystack)) return 'blocker'
  if (/(test|typecheck|tsc|lint|build|pytest|vitest|jest|bun test|npm test|cargo test|go test|mvn test|gradle test|测试|编译|构建)/i.test(haystack)) {
    return 'verifier'
  }
  if (/(web_fetch|web_search|search|fetch|browser|http|url|source|tavily|brave|duckduckgo|网页|搜索|来源|引用|检索)/i.test(haystack)) {
    return 'source'
  }
  if (/(write|edit|patch|apply|save|create|update|写入|编辑|保存|创建)/i.test(haystack)) return 'artifact'
  return 'tool'
}

function missingP0Reason(kind: ReliabilityKind): string {
  switch (kind) {
    case 'coding':
      return '没有看到测试、typecheck、lint 或 build 通过的正向证据，不能声明编码任务完成。'
    case 'research':
      return '没有看到来源检索/抓取证据，调研结论只能视为未验证草案。'
    case 'investment':
      return '投资/计划类输出缺少来源证据或风险/假设披露，不能声明可靠完成。'
    case 'planning':
      return '方案文本缺少风险、假设、约束或下一步等关键结构，不能声明可靠完成。'
    default:
      return '没有可支撑 P0 的正向工具证据，不能声明任务完成。'
  }
}

function successReason(kind: ReliabilityKind): string {
  switch (kind) {
    case 'coding':
      return '编码任务有正向验证证据支撑。'
    case 'research':
      return '调研结论有来源证据支撑。'
    case 'investment':
      return '计划有来源证据，并包含风险/假设披露。'
    case 'planning':
      return '方案文本具备关键结构，可作为交付草案。'
    default:
      return '本轮有可见交付物和正向工具证据。'
  }
}

function hasRiskLanguage(text: string): boolean {
  return /(风险|假设|约束|不构成投资建议|免责声明|回撤|情景|敏感性|risk|assumption|constraint|scenario|drawdown|not financial advice)/i.test(text)
}

function hasPlanStructure(text: string): boolean {
  const hits = [
    /(目标|背景|问题|goal|objective)/i,
    /(步骤|路线图|执行|计划|milestone|roadmap|step|action)/i,
    /(风险|假设|约束|依赖|risk|assumption|constraint|dependency)/i,
    /(下一步|验收|指标|next|metric|acceptance)/i,
  ].filter((re) => re.test(text)).length
  return hits >= 2
}

function previewToolResult(ev: NativeToolResultLike): string {
  const contentText = (ev.content ?? [])
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (contentText) return contentText.slice(0, 240)
  if (typeof ev.details === 'string' && ev.details.trim()) return ev.details.trim().replace(/\s+/g, ' ').slice(0, 240)
  if (ev.details !== undefined) return safeJson(ev.details).replace(/\s+/g, ' ').slice(0, 240)
  return ''
}

function formatEvidenceLine(evidence: ReliabilityEvidence[]): string {
  if (evidence.length === 0) return ''
  const counts = new Map<string, { ok: number; fail: number }>()
  for (const ev of evidence) {
    const prev = counts.get(ev.kind) ?? { ok: 0, fail: 0 }
    if (ev.ok) prev.ok += 1
    else prev.fail += 1
    counts.set(ev.kind, prev)
  }
  return [...counts.entries()]
    .map(([kind, c]) => `${kind} +${c.ok}${c.fail ? `/-${c.fail}` : ''}`)
    .join(', ')
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'null'
  } catch {
    return String(v)
  }
}
