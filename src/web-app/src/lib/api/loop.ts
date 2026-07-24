/**
 * Loop status API — kept out of the main endpoints facade so the Portal
 * status strip can lazy-load without bloating the SPA entry chunk.
 */

import { client } from './client'

export type LoopStatusDto = {
  id: string
  status: string
  bucket: 'aligning' | 'dispatch' | 'verify' | 'ended'
  bucketLabel: string
  active: boolean
  round: number
  maxRounds: number
  objective: string
  exitDescription: string
  acceptance?: string
  dispatchesThisRound: number
  endReason?: string
  lastVerification?: {
    met: boolean
    summary: string
    gaps?: string[]
    nextDirection?: string
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
