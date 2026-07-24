import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatMessage, PendingApproval, PendingAsk } from '@/hooks/use-chat'
import { useBgjobs } from '@/hooks/use-bgjobs'
import type { LoopStatusDto } from '@/lib/api/loop'
import type { BgjobSummary } from '@/types/api'
import { displayAgentName } from './agent-visuals'
import type { PetAnnounce, PetTaskItem } from './portal-pet'

interface UsePortalPetTasksOptions {
  chatMessages: ChatMessage[]
  isTyping: boolean
  currentReplyId: string | null | undefined
  agentId: string
  pendingApprovals: PendingApproval[]
  pendingAsks: PendingAsk[]
  portalThreadId: string | null
  /** Active Loop (if any) — shown as a pet progress task + bubble. */
  loop?: LoopStatusDto | null
  demoPet: boolean
}

export interface UsePortalPetTasksReturn {
  petTasks: PetTaskItem[]
  petAnnounce: PetAnnounce | null
  setPetAnnounce: Dispatch<SetStateAction<PetAnnounce | null>>
  threadBgjobs: BgjobSummary[]
}

export function usePortalPetTasks({
  chatMessages,
  isTyping,
  currentReplyId,
  agentId,
  pendingApprovals,
  pendingAsks,
  portalThreadId,
  loop,
  demoPet,
}: UsePortalPetTasksOptions): UsePortalPetTasksReturn {
  const { t, i18n } = useTranslation()
  const zh = i18n.language?.startsWith('zh')
  const [petAnnounce, setPetAnnounce] = useState<PetAnnounce | null>(null)

  const { data: bgjobData } = useBgjobs(
    {
      root: 'agim',
      status: 'running,paused,starting',
      threadId: portalThreadId ?? undefined,
      platform: 'web',
    },
    { enabled: Boolean(portalThreadId) },
  )
  const threadBgjobs = useMemo((): BgjobSummary[] => {
    if (!bgjobData) return []
    const rows = bgjobData.jobs
      ?? bgjobData.groups?.flatMap((g) => g.jobs)
      ?? []
    if (!portalThreadId) return []
    return rows.filter((j) => j.origin?.threadId === portalThreadId)
  }, [bgjobData, portalThreadId])

  const seenBgjobIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const live = new Set(threadBgjobs.map((j) => j.id))
    // First paint: seed without announcing historical completions.
    if (seenBgjobIdsRef.current.size === 0 && live.size > 0) {
      seenBgjobIdsRef.current = live
      return
    }
    for (const id of seenBgjobIdsRef.current) {
      if (live.has(id)) continue
      seenBgjobIdsRef.current.delete(id)
      setPetAnnounce({
        id: `bgjob-done-${id}-${Date.now()}`,
        text: t('chat.portal.pet.bgjobDone'),
        tone: 'ok',
      })
    }
    for (const id of live) seenBgjobIdsRef.current.add(id)
  }, [threadBgjobs, t])

  const petTasks = useMemo((): PetTaskItem[] => {
    const items: PetTaskItem[] = []
    if (loop?.active) {
      const label = loop.bucketLabel
        || t(`chat.portal.pet.loopBucket.${loop.bucket}`, {
          defaultValue: loop.bucket,
        })
      const obj = (loop.objective || '').trim()
      const shortObj = obj.length > 36 ? `${obj.slice(0, 36)}…` : obj
      const round = zh
        ? `第 ${loop.round}/${loop.maxRounds} 轮`
        : `R${loop.round}/${loop.maxRounds}`
      const usage = loop.usage
        ? (zh
          ? `派工 ${loop.usage.dispatchCount} · 验收 ${loop.usage.evaluatorCount}`
          : `${loop.usage.dispatchCount} dispatch · ${loop.usage.evaluatorCount} eval`)
        : ''
      const detail = [shortObj || undefined, round, usage].filter(Boolean).join(' · ')
      items.push({
        id: `loop-${loop.id}`,
        kind: 'loop',
        label,
        detail: detail || undefined,
      })
    }
    for (const msg of chatMessages) {
      if (msg.role !== 'assistant' || !msg.activity) continue
      if (msg.activity.status !== 'running') continue
      const live = [...msg.activity.steps].reverse().find(
        (s) => s.status === 'running' || s.status === 'pending',
      )
      items.push({
        id: `run-${msg.activity.runId || msg.id}`,
        kind: 'run',
        label: msg.agent ? displayAgentName(msg.agent) : t('chat.portal.pet.runLabel'),
        detail: live?.label
          || t('chat.activityRunning', { defaultValue: 'Running' }),
      })
    }
    if (isTyping && !items.some((i) => i.kind === 'run')) {
      items.push({
        id: `run-${currentReplyId ?? 'streaming'}`,
        kind: 'run',
        label: displayAgentName(agentId),
        detail: t('chat.activityRunning', { defaultValue: 'Running' }),
      })
    }
    for (const ap of pendingApprovals) {
      if (ap.outcome) continue
      items.push({
        id: `apv-${ap.messageId}`,
        kind: 'approval',
        label: t('chat.portal.pet.approvalLabel'),
        detail: ap.prompt?.toolName || undefined,
      })
    }
    for (const ask of pendingAsks) {
      if (ask.finalText) continue
      items.push({
        id: `ask-${ask.messageId}`,
        kind: 'ask',
        label: t('chat.portal.pet.askLabel'),
        detail: ask.prompt?.body || ask.prompt?.title || undefined,
      })
    }
    for (const job of threadBgjobs) {
      const prog = job.progress
      let detail = t(`chat.portal.pet.bgjobStatus.${job.status}`, { defaultValue: job.status })
      let progressPct: number | null = null
      if (prog?.total && prog.total > 0 && prog.done != null) {
        progressPct = Math.round((100 * prog.done) / prog.total)
        const stage = prog.stage || prog.label || ''
        detail = stage
          ? `${stage} ${prog.done}/${prog.total}`
          : `${prog.done}/${prog.total}`
        if (prog.eta_sec != null && prog.eta_sec > 0) {
          detail += ` · ETA ${Math.ceil(prog.eta_sec / 60)}m`
        }
      }
      items.push({
        id: `bgjob-${job.id}`,
        kind: 'bgjob',
        label: job.name || job.id,
        detail,
        progressPct,
      })
    }
    if (demoPet) {
      items.push(
        {
          id: 'demo-apv',
          kind: 'approval',
          label: t('chat.portal.pet.approvalLabel'),
          detail: 'bash',
        },
        {
          id: 'demo-ask',
          kind: 'ask',
          label: t('chat.portal.pet.askLabel'),
          detail: '要用简洁版还是详细版？',
        },
        {
          id: 'demo-bgjob',
          kind: 'bgjob',
          label: 'train-smoke',
          detail: 'B1 120/500 · ETA 6m',
          progressPct: 24,
        },
      )
    }
    return items
  }, [
    chatMessages,
    isTyping,
    currentReplyId,
    pendingApprovals,
    pendingAsks,
    threadBgjobs,
    agentId,
    loop,
    demoPet,
    t,
    zh,
  ])

  // Float a left-drifting bubble when a run finishes.
  const activityStatusRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    const prev = activityStatusRef.current
    const next = new Map(prev)
    for (const msg of chatMessages) {
      if (msg.role !== 'assistant' || !msg.activity) continue
      const key = msg.activity.runId || msg.id
      const cur = msg.activity.status
      const was = prev.get(key)
      if (was === 'running' && (cur === 'success' || cur === 'error')) {
        const agent = msg.agent ? displayAgentName(msg.agent) : 'Agim'
        setPetAnnounce({
          id: `done-${key}-${cur}-${msg.activity.finishedAt ?? Date.now()}`,
          text: cur === 'success'
            ? t('chat.portal.pet.doneOk', { agent })
            : t('chat.portal.pet.doneErr', { agent }),
          tone: cur === 'success' ? 'ok' : 'err',
        })
      }
      next.set(key, cur)
    }
    activityStatusRef.current = next
  }, [chatMessages, t])

  // demo=pet — fire completion floats so recording can capture the drift.
  useEffect(() => {
    if (!demoPet) return
    const fire = (): void => {
      setPetAnnounce({
        id: `demo-pet-done-${Date.now()}`,
        text: t('chat.portal.pet.doneOk', { agent: 'Agim' }),
        tone: 'ok',
      })
    }
    const first = window.setTimeout(fire, 1600)
    const loop = window.setInterval(fire, 4500)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(loop)
    }
  }, [demoPet, t])

  return { petTasks, petAnnounce, setPetAnnounce, threadBgjobs }
}
