/**
 * Loop status API — kept out of the main endpoints facade so the Portal
 * status strip can lazy-load without bloating the SPA entry chunk.
 */

import { client } from './client'

export type LoopStatusDto = {
  id: string
  status: string
  bucket: 'aligning' | 'dispatch' | 'verify' | 'confirm' | 'ended'
  bucketLabel: string
  active: boolean
  round: number
  minRounds?: number
  maxRounds: number
  objective: string
  exitDescription: string
  acceptance?: string
  dispatchesThisRound: number
  /** In-flight Subagent jobs for this round (pending|running). */
  liveSubagents?: number
  /** Ready for loop_verdict (dispatched, no live children this round). */
  canVerify?: boolean
  endReason?: string
  lastVerification?: {
    met: boolean
    summary: string
    gaps?: string[]
    nextDirection?: string
  }
  pendingConfirmation?: {
    summary: string
    gaps?: string[]
    evaluatorReason?: string
    minRounds?: number
    belowMinRounds: boolean
  }
  usage?: {
    dispatchCount: number
    evaluatorCount: number
    continueCount: number
    reviseCount: number
  }
  updatedAt: number
}

export function getLoop(query: {
  threadId: string
  platform?: string
  channelId?: string
  lang?: 'zh' | 'en'
}): Promise<{ ok: boolean; loop: LoopStatusDto | null }> {
  return client.get('/api/loop', { query })
}

export function confirmLoopMet(body: {
  threadId: string
  action: 'end' | 'continue'
  supplement?: string
  platform?: string
  channelId?: string
  lang?: 'zh' | 'en'
}): Promise<{
  ok: boolean
  loop: LoopStatusDto | null
  error?: string
  /** Present after action=end — durable Loop ended card posted to the transcript. */
  endedSummary?: string
  /** After end — offer the Subagent detail-report dock. */
  suggestReport?: boolean
  childJobCount?: number
}> {
  return client.post('/api/loop/confirm-met', { body })
}

