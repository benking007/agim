// Batch 2 (#2 Stop) — find the running agent run on the user's current
// thread and abort it. Triggered by `/abort`, plain text "stop",
// "停止", "中止", or "esc". The aborted run's controller cleanup is
// the same as a normal cancel: job-board emits 'job.cancelled' and the
// inflight bytes already produced are kept on the row (debugging aid).
//
// Distinct from { type: 'service', action: 'stop' } which shuts down
// the agim daemon and is admin-gated.

import type { RouteContext } from '../router.js'
import {
  abortChildJobsForParentTurn,
  findActiveJobByThread,
  cancelJob,
} from '../job-board.js'

export function handleStopAgentCommand(ctx: RouteContext): string {
  const threadKey = `${ctx.platform}:${ctx.channelId}:${ctx.threadId}`
  const children = abortChildJobsForParentTurn(
    ctx.platform,
    ctx.channelId,
    ctx.threadId,
    'cancelled: parent stop',
  )
  const job = findActiveJobByThread(threadKey)
  if (!job && children === 0) {
    return '⚠️ 当前会话没有正在跑的 agent 任务，无需中止。\n（停服务请用 /restart 或 /stop，管理员限定）'
  }
  if (job) {
    const ok = cancelJob(job.id)
    if (!ok && children === 0) {
      return `⚠️ 无法中止 job #${job.id}（可能刚刚已结束）。`
    }
    ctx.logger.info({
      event: 'agent.stop_requested',
      jobId: job.id,
      threadKey,
      cancelledChildren: children,
    })
    const extra = children > 0 ? `；并中止 ${children} 个子代理` : ''
    return `🛑 已中止当前 agent 任务 (#${job.id} · ${job.agent})${extra}。`
  }
  ctx.logger.info({
    event: 'agent.stop_requested_children_only',
    threadKey,
    cancelledChildren: children,
  })
  return `🛑 已中止 ${children} 个在途子代理。`
}
