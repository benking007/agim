import { approvalBus } from './approval-bus.js'

/** Human round-trip budget for explicit confirmation cards. */
export function resolveGoalConfirmationTimeoutMs(): number {
  const raw = (process.env.AGIM_GOAL_CONFIRMATION_TIMEOUT_MS ?? '').trim()
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return approvalBus.approvalTimeoutMs
}
