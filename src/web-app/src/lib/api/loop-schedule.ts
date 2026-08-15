import { client } from './client'

export interface LoopSchedulePending {
  name?: string
  cron: string
  cronLabel?: string
  timeText: string
  objective: string
  exitDescription: string
  headless: boolean
  createdAt: number
}

export async function getLoopSchedulePending(threadId: string): Promise<LoopSchedulePending | null> {
  const res = await client.get<{ ok: boolean; pending: LoopSchedulePending | null }>(
    '/api/loop-schedule/pending',
    { query: { threadId } },
  )
  return res.pending ?? null
}

export function confirmLoopSchedule(body: {
  threadId: string
  timeText?: string
  cron?: string
  objective: string
  exitDescription: string
  headless?: boolean
}): Promise<{ ok: true; id: number; nextIso: string }> {
  return client.post('/api/loop-schedule/confirm', { body })
}

export function cancelLoopSchedule(threadId: string): Promise<{ ok: true }> {
  return client.post('/api/loop-schedule/cancel', { body: { threadId } })
}
