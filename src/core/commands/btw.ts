// Batch 2 (#5 /btw) — by-the-way side question. Ship a quick one-shot
// agent run on a parallel sub-thread without waiting for the main
// thread's queue lock. The main session's history is left untouched;
// the sub-thread is keyed `${threadId}:btw:${epoch}` so subsequent
// `/btw` calls don't share memory either (each one is independent).
//
// `cli.ts:willInvokeAgent` only enters the per-thread queue for
// {default, agent, agentCommand} types — `btw` is not in that set, so
// this command runs concurrently with whatever's pending on the main
// thread. That's the bypass.

import type { RouteContext } from '../router.js'
import { callAgentWithHistory } from '../router.js'
import { registry } from '../registry.js'
import { sessionManager } from '../session.js'

export async function handleBtwCommand(
  prompt: string,
  ctx: RouteContext,
): Promise<string | AsyncGenerator<string>> {
  const q = (prompt || '').trim()
  if (!q) {
    return '用法：/btw <快速问题>。会绕过主会话队列，开一个一次性的小线程回答你。'
  }

  // Pick whatever the operator set as default; /btw deliberately does
  // NOT consult intent classification — the assumption is "I just want
  // a quick answer; don't switch agents on me." Operators wanting a
  // specific agent can use the normal `/codex …` / `/opencode …`
  // explicit-agent shorthand instead.
  const agent = registry.findAgent(ctx.defaultAgent)
  if (!agent) {
    return `❌ 默认 agent "${ctx.defaultAgent}" 不可用。请先 /agents 检查或 agim config 配一个。`
  }

  // Side sub-thread id. epoch ms is enough — collisions only matter if
  // a user spams /btw within the same millisecond, in which case both
  // runs being equivalent isn't a correctness issue.
  const subThreadId = `${ctx.threadId}:btw:${Date.now()}`
  // Empty history: /btw is intentionally context-free. The agent only
  // sees the side question itself.
  const session = await sessionManager.getOrCreateSession(
    ctx.platform, ctx.channelId, subThreadId, agent.name,
  )

  ctx.logger.info({
    event: 'btw.dispatch',
    agent: agent.name,
    promptLen: q.length,
    subThreadId,
  })

  return callAgentWithHistory(
    agent, session.id, q, session.messages, ctx,
    session.model, session.variant, session.planMode,
    { storageThreadId: subThreadId },
  )
}
