/**
 * Phase B — parallel Subagent fan-out knobs + concurrency helper.
 *
 * Concept: docs/architecture/orchestration-roadmap.md §Phase B
 * Naming: docs/naming.md (AGIM_SUBAGENT_PARALLEL*)
 *
 * Defaults (product choice 2026-07-29):
 *   AGIM_SUBAGENT_PARALLEL        ON when unset
 *   AGIM_SUBAGENT_PARALLEL_MAX    3  (in-batch concurrency)
 *   AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN  6  (raised from 3)
 */

export const SUBAGENT_PARALLEL_MAX_DEFAULT = 3
export const CALL_AGENT_MAX_PER_TURN_DEFAULT = 6
/** Hard ceiling on tasks[] length regardless of env (abuse guard). */
export const CALL_AGENTS_TASKS_HARD_MAX = 8

/** Parallel fan-out for mcp__agim__call_agents. Default ON; set 0|off|false|no to serialize. */
export function isSubagentParallelEnabled(): boolean {
  const raw = (process.env.AGIM_SUBAGENT_PARALLEL ?? '').toLowerCase().trim()
  if (!raw) return true
  return !(raw === '0' || raw === 'off' || raw === 'false' || raw === 'no')
}

/** Max concurrent Subagent runs inside one call_agents batch. Default 3. */
export function getSubagentParallelMax(): number {
  const raw = process.env.AGIM_SUBAGENT_PARALLEL_MAX
  if (!raw?.trim()) return SUBAGENT_PARALLEL_MAX_DEFAULT
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 1) return SUBAGENT_PARALLEL_MAX_DEFAULT
  return Math.min(n, CALL_AGENTS_TASKS_HARD_MAX)
}

/** Per-turn call_agent + call_agents task budget. Default 3; 0 disables. */
export function getCallAgentMaxPerTurn(): number {
  const raw = process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN
  if (raw === undefined || raw.trim() === '') return CALL_AGENT_MAX_PER_TURN_DEFAULT
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : CALL_AGENT_MAX_PER_TURN_DEFAULT
}

/**
 * Run `fn` over items with a fixed worker pool. Order of results matches
 * input order (allSettled-style: one failure does not cancel siblings —
 * callers should catch inside `fn`).
 */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const limit = Math.max(1, Math.min(concurrency, items.length))
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const i = next
      next += 1
      if (i >= items.length) return
      results[i] = await fn(items[i] as T, i)
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()))
  return results
}
