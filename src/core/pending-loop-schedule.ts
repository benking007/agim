// pending-loop-schedule.ts — short-lived "create this scheduled Loop?"
// state for the NL confirmation card.
//
// Same shape as pending-reminder: in-memory, 5 min TTL, y/n consume.
// A stale "y" after restart must not create a surprise cron.

const PENDING_TTL_MS = 5 * 60 * 1000

export interface PendingLoopSchedule {
  name: string
  cron: string
  cronLabel: string
  objective: string
  exitDescription: string
  headless: boolean
  createdAt: number
}

const store = new Map<string, PendingLoopSchedule>()

function evictExpired(now: number): void {
  for (const [k, v] of store) {
    if (now - v.createdAt > PENDING_TTL_MS) store.delete(k)
  }
}

export function setPendingLoopSchedule(
  threadKey: string,
  p: Omit<PendingLoopSchedule, 'createdAt'>,
): void {
  evictExpired(Date.now())
  store.set(threadKey, { ...p, createdAt: Date.now() })
}

export function getPendingLoopSchedule(threadKey: string): PendingLoopSchedule | null {
  evictExpired(Date.now())
  return store.get(threadKey) ?? null
}

export function clearPendingLoopSchedule(threadKey: string): void {
  store.delete(threadKey)
}

export function _sizeLoopScheduleForTest(): number { return store.size }
export function _clearLoopScheduleForTest(): void { store.clear() }

const CONFIRM_PAT = /^(y|yes|是|确认|对|好|ok|可以|创建)\s*$/i
const CANCEL_PAT = /^(n|no|否|取消|不|算了|不用|skip)\s*$/i

export function tryConsumeLoopScheduleReply(threadKey: string, text: string):
  | { decision: 'confirm'; pending: PendingLoopSchedule }
  | { decision: 'cancel'; pending: PendingLoopSchedule }
  | null
{
  const pending = getPendingLoopSchedule(threadKey)
  if (!pending) return null
  const t = text.trim()
  if (CONFIRM_PAT.test(t)) {
    clearPendingLoopSchedule(threadKey)
    return { decision: 'confirm', pending }
  }
  if (CANCEL_PAT.test(t)) {
    clearPendingLoopSchedule(threadKey)
    return { decision: 'cancel', pending }
  }
  return null
}
