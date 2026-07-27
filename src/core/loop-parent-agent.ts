/**
 * Loop Engineering parent-agent gate.
 *
 * Loop orchestration (call_agents / loop_verdict / dispatch+verify gates)
 * only exists on Agim Agent. CLI backends (Codex, Claude Code, …) may still
 * run as Subagents via call_agents, but must not be the Loop parent —
 * they lack those tools, and packing history+Loop snippets into spawn argv
 * often hits kernel E2BIG ("Agent error: spawn E2BIG").
 */

import { isAgimAgentId } from './naming-migrate.js'

/** True when this sticky/default agent can parent a Loop. */
export function canParentLoop(agentId: string | undefined | null): boolean {
  return isAgimAgentId(agentId)
}

/** Non-Agim sticky agents are valid Loop Subagent / preferred-worker targets. */
export function isLoopWorkerAgent(agentId: string | undefined | null): boolean {
  const id = (agentId || '').trim()
  return id.length > 0 && !isAgimAgentId(id)
}

/**
 * Update session.preferredWorkerAgent across sticky switches:
 * - selecting a CLI → that CLI becomes the preferred Loop worker
 * - switching CLI → Agim → keep the previous CLI as preferred worker
 * - Agim → Agim → leave stored preference unchanged
 */
export function nextPreferredWorkerAgent(
  previousAgent: string | undefined | null,
  newAgent: string,
  stored?: string | undefined | null,
): string | undefined {
  if (isLoopWorkerAgent(newAgent)) return newAgent.trim()
  if (isLoopWorkerAgent(previousAgent)) return (previousAgent || '').trim()
  const kept = (stored || '').trim()
  return isLoopWorkerAgent(kept) ? kept : undefined
}

/** Resolve which CLI (if any) Loop should prefer in call_agents. */
export function resolvePreferredWorkerAgent(
  stickyAgent: string | undefined | null,
  stored?: string | undefined | null,
): string | undefined {
  if (isLoopWorkerAgent(stored)) return (stored || '').trim()
  if (isLoopWorkerAgent(stickyAgent)) return (stickyAgent || '').trim()
  return undefined
}

export function formatLoopParentRequired(agentId: string | undefined | null, lang: 'zh' | 'en' = 'zh'): string {
  const current = (agentId || '').trim() || (lang === 'zh' ? '当前 Agent' : 'current agent')
  if (lang === 'en') {
    return [
      `⛔ Loop parent must be **Agim Agent** (current: \`${current}\`).`,
      '',
      'CLI agents (Codex / Claude Code / …) cannot run `call_agents` / `loop_verdict`,',
      'and large Loop context often fails with `spawn E2BIG`.',
      '',
      'Switch the Portal agent to **Agim** (orchestrator), then retry `/loop` or Act now.',
      isLoopWorkerAgent(current)
        ? `Agim will prefer dispatching **\`${current}\`** via \`call_agents\` (Subagent).`
        : 'Codex and others can still be used as **Subagents** after Agim dispatches them.',
    ].join('\n')
  }
  return [
    `⛔ Loop 父编排必须用 **Agim Agent**（当前：\`${current}\`）。`,
    '',
    'Codex / Claude Code 等 CLI Agent **没有** `call_agents` / `loop_verdict`，',
    '且大段 Context 塞进命令行参数时容易 `spawn E2BIG` 直接失败。',
    '',
    '请在 Portal 把 Agent 切回 **Agim**（编排），再 `/loop` 或点「立即行动」。',
    isLoopWorkerAgent(current)
      ? `切回后 Agim 会优先用 \`call_agents\` 派 **\`${current}\`** 干活（子代理）。`
      : 'Codex 等仍可作为 **子代理**，由 Agim 通过 `call_agents` 派工调用。',
  ].join('\n')
}
