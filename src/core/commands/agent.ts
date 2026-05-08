// Agent commands: /test /review /commit /push /diff /shell /bug /explain
// These are forwarded to the active agent with the command prefix

import type { RouteContext } from '../router.js'
import { registry } from '../registry.js'
import { sessionManager } from '../session.js'
import { isAgentAvailableCached, formatAgentNotAvailableError } from '../onboarding.js'
import { getJob } from '../job-board.js'
import { callAgentWithHistory, prepareSubtaskAgentCallOptions } from '../router.js'

export async function handleAgentCommand(
  command: string,
  prompt: string,
  ctx: RouteContext
): Promise<string | ReturnType<typeof callAgentWithHistory>> {
  const existingSession = await sessionManager.getExistingSession(ctx.platform, ctx.channelId, ctx.threadId)
  const fullPrompt = `/${command} ${prompt}`.trim()

  if (existingSession?.activeSubtaskId) {
    const tid = existingSession.activeSubtaskId
    const job = getJob(tid) ?? existingSession.subtasks?.find((subtask) => subtask.id === tid)
    if (!job) {
      return `❌ 任务 #${tid} 已不存在。使用 /job switch main 返回主会话。`
    }

    const subtaskAgent = registry.findAgent(job.agent)
    if (!subtaskAgent) {
      return `❌ 任务 #${tid} 的 Agent "${job.agent}" 不可用。`
    }

    if (!(await isAgentAvailableCached(subtaskAgent.name))) {
      return formatAgentNotAvailableError(subtaskAgent.name)
    }

    const subThreadId = `${ctx.threadId}:sub:${tid}`
    const subSession = await sessionManager.getOrCreateSubSession(
      ctx.platform, ctx.channelId, ctx.threadId, tid, subtaskAgent.name,
    )
    const callOptions = await prepareSubtaskAgentCallOptions(subtaskAgent.name, ctx, subThreadId, subSession)
    return callAgentWithHistory(
      subtaskAgent, subSession.id, fullPrompt, subSession.messages, ctx,
      subSession.model, subSession.variant, subSession.planMode, callOptions,
    )
  }

  const agentName = existingSession?.agent || ctx.defaultAgent

  const agent = registry.findAgent(agentName)
  if (!agent) {
    return `❌ Agent "${agentName}" not found. Use /agents to see available agents.`
  }

  if (!(await isAgentAvailableCached(agent.name))) {
    return formatAgentNotAvailableError(agent.name)
  }

  const session = await sessionManager.getOrCreateSession(
    ctx.platform, ctx.channelId, ctx.threadId, agent.name
  )
  return callAgentWithHistory(agent, session.id, fullPrompt, session.messages, ctx, session.model, session.variant, session.planMode)
}
