// Agent commands: /test /review /commit /push /diff /shell /bug /explain
// These are forwarded to the active agent with the command prefix

import type { RouteContext } from '../router.js'
import { registry } from '../registry.js'
import { sessionManager } from '../session.js'
import { isAgentAvailableCached, formatAgentNotAvailableError } from '../onboarding.js'
import { imText, resolveImLang } from '../im-i18n.js'
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
    const lang = resolveImLang({ platform: ctx.platform, userId: ctx.userId, channelId: ctx.channelId })
    if (!job) {
      return imText(lang,
        `❌ 任务 #${tid} 已不存在。使用 /job switch main 返回主会话。`,
        `❌ Job #${tid} no longer exists. Use /job switch main to return to the main session.`,
      )
    }

    const subtaskAgent = registry.findAgent(job.agent)
    if (!subtaskAgent) {
      return imText(lang,
        `❌ 任务 #${tid} 的 Agent "${job.agent}" 不可用。`,
        `❌ Agent "${job.agent}" for job #${tid} is unavailable.`,
      )
    }

    if (!(await isAgentAvailableCached(subtaskAgent.name))) {
      return formatAgentNotAvailableError(subtaskAgent.name, lang)
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

  const lang = resolveImLang({ platform: ctx.platform, userId: ctx.userId, channelId: ctx.channelId })
  const agent = registry.findAgent(agentName)
  if (!agent) {
    return imText(lang,
      `❌ 找不到 Agent "${agentName}"。用 /agents 查看可用 Agent。`,
      `❌ Agent "${agentName}" not found. Use /agents to list available agents.`,
    )
  }

  if (!(await isAgentAvailableCached(agent.name))) {
    return formatAgentNotAvailableError(agent.name, lang)
  }

  const session = await sessionManager.getOrCreateSession(
    ctx.platform, ctx.channelId, ctx.threadId, agent.name
  )
  return callAgentWithHistory(agent, session.id, fullPrompt, session.messages, ctx, session.model, session.variant, session.planMode)
}
