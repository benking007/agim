// loop-report — assemble a detailed Loop analysis report from Subagent
// job outputs after the user confirms met-end. Deterministic markdown
// (no extra LLM). Persists under `<agent-cwd>/PROJECTS/loops/`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultAgentCwd } from './agent-cwd.js'
import { getArtifactsDir } from './artifacts.js'

/** Keep in sync with `A2A_FULL_RESULT_FILE` in a2a.ts (avoid import cycle). */
const A2A_FULL_RESULT_FILE = '__a2a_result_full.md'
import {
  getJob,
  jobThreadKey,
  listChildJobsByThread,
  type Job,
} from './job-board.js'
import {
  formatLoopEndedSummary,
  getLoopRun,
  getMissionView,
  type LoopRun,
} from './loop-run.js'
import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'loop-report' })

const PER_JOB_CHARS = 14_000
const CHAT_BODY_CHARS = 72_000

/**
 * Default: Agim workspace `PROJECTS/loops/` (alongside project archives).
 * Override with `AGIM_LOOP_REPORTS_DIR` for tests / custom deployments.
 */
export function resolveLoopReportsDir(agentName = 'agim'): string {
  if (process.env.AGIM_LOOP_REPORTS_DIR) return process.env.AGIM_LOOP_REPORTS_DIR
  return join(defaultAgentCwd(agentName), 'PROJECTS', 'loops')
}

function ensureReportsDir(): string {
  const dir = resolveLoopReportsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120)
}

/** Prefer spilled full result; fall back to job.result (may be truncated). */
export function readJobResultBody(job: Job): string {
  try {
    const fullPath = join(getArtifactsDir(job.id).outputDir, A2A_FULL_RESULT_FILE)
    if (existsSync(fullPath)) {
      return readFileSync(fullPath, 'utf-8')
    }
  } catch { /* fall through */ }
  return job.result || job.error || ''
}

/** Soft upper bound after Loop end for late-completing Subagents (legacy filter). */
const LOOP_WINDOW_TAIL_MS = 5 * 60_000

/**
 * Keep only jobs whose create time falls inside this Loop's lifetime.
 * Used when older persisted runs lack `loopJobIds`.
 */
export function filterJobsByLoopWindow(jobs: Job[], run: LoopRun): Job[] {
  const start = Number(run.createdAt) || 0
  const end = (Number(run.updatedAt) || start) + LOOP_WINDOW_TAIL_MS
  if (start <= 0) return []
  return jobs.filter((j) => {
    const t = Date.parse(j.created_at || '')
    return Number.isFinite(t) && t >= start && t <= end
  })
}

function jobsFromIds(ids: number[]): Job[] {
  const out: Job[] = []
  const seen = new Set<number>()
  for (const id of ids) {
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue
    seen.add(id)
    const j = getJob(id)
    if (j) out.push(j)
  }
  return out
}

/**
 * Subagent jobs that belong to **this Loop only** — not historical A2A on
 * the same thread from earlier Loops or ad-hoc call_agent.
 *
 * Prefer cumulative `loopJobIds`; fall back to time-window filter on the
 * thread list; last resort is the final round's `roundJobIds`.
 */
export function collectChildJobs(run: LoopRun): Job[] {
  const loopIds = Array.isArray(run.loopJobIds) ? run.loopJobIds : []
  if (loopIds.length > 0) return jobsFromIds(loopIds)

  const threadKey = jobThreadKey(run.platform, run.channelId, run.threadId)
  const byThread = listChildJobsByThread(threadKey, { limit: 80 })
  const inWindow = filterJobsByLoopWindow(byThread, run)
  if (inWindow.length > 0) return inWindow

  const roundIds = Array.isArray(run.roundJobIds) ? run.roundJobIds : []
  return jobsFromIds(roundIds)
}

export function countLoopChildJobs(
  platform: string,
  channelId: string,
  threadId: string,
): number {
  const run = getLoopRun(platform, channelId, threadId)
  if (!run) return 0
  return collectChildJobs(run).length
}

export function buildLoopDetailReport(run: LoopRun, jobs: Job[]): string {
  const view = getMissionView(run)
  const lines: string[] = [
    `# Loop 详细分析报告`,
    '',
    `> 由 Loop \`${run.id}\` 结案后根据各子代理输出汇总生成（确定性拼装，未再调用 LLM）。`,
    '',
    `## 目标与退出`,
    '',
    `- **目标**：${view.objective || '（无）'}`,
    `- **退出条件**：${view.exitDescription || '（无）'}`,
    `- **轮次**：${run.round}/${view.maxRounds}`,
    `- **结束原因**：\`${run.endReason ?? 'ended'}\``,
    '',
    `## Loop 结束摘要`,
    '',
    formatLoopEndedSummary(run),
    '',
    `## 子代理明细（共 ${jobs.length} 个）`,
    '',
  ]

  if (jobs.length === 0) {
    lines.push('_本 Loop 未找到子代理任务记录；报告仅含 Loop 摘要。_')
    lines.push('')
    return lines.join('\n')
  }

  jobs.forEach((job, i) => {
    const body = readJobResultBody(job).trim()
    const clipped = body.length > PER_JOB_CHARS
      ? `${body.slice(0, PER_JOB_CHARS)}\n\n…[已截断：该子代理输出 ${body.length} 字符，报告内保留前 ${PER_JOB_CHARS} 字符]`
      : (body || '_（无输出）_')
    const promptHead = (job.prompt || '').trim().slice(0, 400)
    lines.push(`### ${i + 1}. 子代理 #${job.id} · \`${job.agent || 'unknown'}\``)
    lines.push('')
    lines.push(`- **状态**：${job.status}`)
    if (job.created_at) lines.push(`- **创建**：${job.created_at}`)
    if (job.completed_at) lines.push(`- **完成**：${job.completed_at}`)
    if (promptHead) {
      lines.push(`- **任务摘要**：${promptHead}${job.prompt && job.prompt.length > 400 ? '…' : ''}`)
    }
    lines.push('')
    lines.push(clipped)
    lines.push('')
    lines.push('---')
    lines.push('')
  })

  lines.push(`## 综合说明`)
  lines.push('')
  lines.push(
    '以上各节按子代理派出顺序排列，便于对照证据。'
    + '如需进一步润色成对外研报，可在聊天中继续要求 Agent 基于本文件改写。',
  )
  lines.push('')
  return lines.join('\n')
}

export interface GenerateLoopReportResult {
  ok: true
  path: string
  markdown: string
  chatMarkdown: string
  jobCount: number
  loopId: string
}

export interface GenerateLoopReportError {
  ok: false
  error: string
}

/**
 * Build + persist a Loop detail report, returning markdown for chat posting.
 */
export function generateLoopDetailReport(
  platform: string,
  channelId: string,
  threadId: string,
  opts: { loopId?: string } = {},
): GenerateLoopReportResult | GenerateLoopReportError {
  const run = getLoopRun(platform, channelId, threadId)
  if (!run) return { ok: false, error: 'no_loop' }
  if (opts.loopId && opts.loopId !== run.id) return { ok: false, error: 'loop_id_mismatch' }
  if (run.status !== 'ended') return { ok: false, error: 'loop_not_ended' }

  const jobs = collectChildJobs(run)
  const markdown = buildLoopDetailReport(run, jobs)
  const dir = ensureReportsDir()
  const file = `${safeName(run.sessionKey)}-${safeName(run.id)}.md`
  const path = join(dir, file)
  try {
    writeFileSync(path, markdown, { encoding: 'utf-8', mode: 0o600 })
  } catch (err) {
    log.warn({ event: 'loop.report.write_failed', path, err: String(err) })
    return { ok: false, error: 'write_failed' }
  }

  const chatBody = markdown.length > CHAT_BODY_CHARS
    ? `${markdown.slice(0, CHAT_BODY_CHARS)}\n\n…[聊天内已截断；完整报告见磁盘文件]`
    : markdown
  const chatMarkdown = [
    chatBody,
    '',
    `📄 **详细报告已落盘**：\`${path}\``,
    '',
    '_可用 read 工具打开上述路径查看全文。_',
  ].join('\n')

  log.info({
    event: 'loop.report.generated',
    loopId: run.id,
    threadId,
    jobCount: jobs.length,
    path,
    chars: markdown.length,
  })

  return {
    ok: true,
    path,
    markdown,
    chatMarkdown,
    jobCount: jobs.length,
    loopId: run.id,
  }
}
