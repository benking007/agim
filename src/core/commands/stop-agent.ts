// Batch 2 (#2 Stop) — find the running agent run on the user's current
// thread and abort it. Triggered by `/abort`, plain text "stop",
// "停止", "中止", or "esc". The aborted run's controller cleanup is
// the same as a normal cancel: job-board emits 'job.cancelled' and the
// inflight bytes already produced are kept on the row (debugging aid).
//
// Distinct from { type: 'service', action: 'stop' } which shuts down
// the agim daemon and is admin-gated.

import type { RouteContext } from '../router.js'
import { findActiveJobByThread, cancelJob } from '../job-board.js'

export function handleStopAgentCommand(ctx: RouteContext): string {
  const threadKey = `${ctx.platform}:${ctx.channelId}:${ctx.threadId}`
  const job = findActiveJobByThread(threadKey)
  if (!job) {
    return '⚠️ 当前会话没有正在跑的 agent 任务，无需中止。\n（停服务请用 /restart 或 /stop，管理员限定）'
  }
  const ok = cancelJob(job.id)
  if (!ok) {
    return `⚠️ 无法中止 job #${job.id}（可能刚刚已结束）。`
  }
  ctx.logger.info({ event: 'agent.stop_requested', jobId: job.id, threadKey })
  return `🛑 已中止当前 agent 任务 (#${job.id} · ${job.agent})。`
}
