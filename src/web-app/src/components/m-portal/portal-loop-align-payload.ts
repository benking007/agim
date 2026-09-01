/** Build the `/loop …` message sent when the aligning dock confirms. */
export function buildAlignPayload(objective: string, exit: string, body?: string): string {
  const o = objective.trim()
  const e = exit.trim()
  const b = (body || '').trim()
  let msg = `/loop ${o}；退出条件为${e}`
  if (b) msg += `；正文：${b}`
  return msg
}

/**
 * Follow-up user turn after Align 「确定并开始」.
 * Mission confirm alone only moves Loop → planning; this nudge starts the
 * parent agent so call_agents actually runs (same text as Act Now / dispatch).
 */
export function buildAlignStartFollowUp(opts: {
  zh: boolean
  preferredWorker?: string
}): string {
  const worker = (opts.preferredWorker || '').trim()
  if (worker) {
    return opts.zh
      ? `开始：请拆解任务并用 call_agents 派子代理（优先 agent:"${worker}"），不要自己做调研。`
      : `Start: decompose and call_agents (prefer agent:"${worker}") this round — do not research alone.`
  }
  return opts.zh
    ? '开始：请拆解任务并用 call_agents 派子代理推进本轮，不要自己做调研。'
    : 'Start: decompose and call_agents to dispatch Subagents this round — do not research alone.'
}
