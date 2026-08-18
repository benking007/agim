/**
 * Portal Loop docks (replaces the blocking status strip):
 * - Aligning: bottom sheet to fill objective + exit, then confirm
 * - Ready (dispatch/verify): "Act now" sheet like ApprovalDock
 * - After confirm-end: offer to ask the Agent for a detail report
 *
 * These only ask for user action — Loop progress is not mirrored onto
 * the pet speech bubble (that cluttered the composer after start).
 */

import { memo, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Compass, FileText, Play, Target, X } from 'lucide-react'

import { MarkdownView } from '@/components/chat/markdown-view'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  confirmLoopMet,
  type LoopStatusDto,
} from '@/lib/api/loop'
import { openChatWs } from '@/lib/api/ws'
import { usePortalLoop } from './use-portal-loop'
import { buildAlignPayload } from './portal-loop-align-payload'
import { buildLoopReportPrompt } from './portal-loop-report-prompt'

/** Max height for the confirm-met summary so long Markdown scrolls inside the dock. */
export const CONFIRM_MET_SUMMARY_MAX_CLASS = 'max-h-56'

type ReportOffer = {
  threadId: string
  loopId: string
  childJobCount: number
}

export interface PortalLoopDockProps {
  threadId: string | null | undefined
  refreshKey?: number | string
  dark?: boolean
  /** Sticky Portal agent id — Loop parent must be Agim. */
  agentId?: string
  /** Preferred CLI Subagent while Agim parents (e.g. codex). */
  preferredWorkerAgent?: string
  /** Switch sticky agent to Agim so Loop can run (keeps preferred worker). */
  onSwitchToAgimParent?: () => void
  /** True while an agent turn is in flight — hide Act Now. */
  busy?: boolean
  /** Approval/Ask dock already open — don't stack Act Now on top. */
  hasBlockingDock?: boolean
  flush?: boolean
  /** Send a chat/slash message on the user's behalf. */
  onSend: (text: string) => void
  className?: string
}

function canParentLoopAgent(agentId: string | undefined): boolean {
  return agentId === 'agim' || agentId === 'native'
}

function resolveWorkerHint(agentId: string | undefined, preferred?: string): string | undefined {
  const sticky = (agentId || '').trim()
  if (sticky && !canParentLoopAgent(sticky)) return sticky
  const stored = (preferred || '').trim()
  if (stored && !canParentLoopAgent(stored)) return stored
  return undefined
}

function actNowPrompt(loop: LoopStatusDto, zh: boolean, preferredWorker?: string): string {
  if (loop.bucket === 'verify') {
    return zh
      ? '请对照目标调用 loop_verdict 完成本轮验收（给出 met / summary；未达标则 gaps + nextDirection）。'
      : 'Call loop_verdict against the objective (met / summary; if unmet: gaps + nextDirection).'
  }
  const worker = (preferredWorker || '').trim()
  if (worker) {
    return zh
      ? `开始：请拆解任务并用 call_agents 派子代理（优先 agent:"${worker}"），不要自己做调研。`
      : `Start: decompose and call_agents (prefer agent:"${worker}") this round — do not research alone.`
  }
  return zh
    ? '开始：请拆解任务并用 call_agents 派子代理推进本轮，不要自己做调研。'
    : 'Start: decompose and call_agents to dispatch Subagents this round — do not research alone.'
}

/** Memoized: composer typing must not re-reconcile AligningDock's long Focus body. */
export const PortalLoopDock = memo(function PortalLoopDock({
  threadId,
  refreshKey,
  dark,
  agentId,
  preferredWorkerAgent,
  onSwitchToAgimParent,
  busy,
  hasBlockingDock,
  flush,
  onSend,
  className,
}: PortalLoopDockProps): JSX.Element | null {
  const { i18n } = useTranslation()
  const zh = Boolean(i18n.language?.startsWith('zh'))
  const { loop, reload } = usePortalLoop(threadId, refreshKey)
  // Survives loop.active → false after「确认结束」.
  const [reportOffer, setReportOffer] = useState<ReportOffer | null>(null)
  const parentOk = canParentLoopAgent(agentId)
  const workerHint = resolveWorkerHint(agentId, preferredWorkerAgent)

  // Clear stale offer when switching threads.
  useEffect(() => {
    setReportOffer((prev) => (prev && prev.threadId !== threadId ? null : prev))
  }, [threadId])

  // After 结案, a follow-up may start a *new* Loop. ReportOffer must not
  // mask Aligning / Act now for the new runId.
  useEffect(() => {
    if (!loop?.active || !reportOffer) return
    if (loop.id !== reportOffer.loopId) setReportOffer(null)
  }, [loop?.active, loop?.id, reportOffer])

  if (reportOffer && reportOffer.threadId === threadId) {
    return (
      <ReportOfferDock
        offer={reportOffer}
        dark={dark}
        flush={flush}
        zh={zh}
        onSend={onSend}
        onDismiss={() => setReportOffer(null)}
        className={className}
      />
    )
  }

  if (!loop?.active) return null
  // Approval / ask_user docks own the composer strip — hide Aligning /
  // Confirm / Act Now so mcp__agim__ask_user can surface AskDock.
  if (hasBlockingDock) return null
  if (loop.bucket === 'aligning') {
    return (
      <AligningDock
        loop={loop}
        dark={dark}
        flush={flush}
        zh={zh}
        onSend={onSend}
        parentOk={parentOk}
        agentId={agentId}
        workerHint={workerHint}
        onSwitchToAgimParent={onSwitchToAgimParent}
        className={className}
      />
    )
  }
  if (loop.bucket === 'confirm') {
    return (
      <ConfirmMetDock
        loop={loop}
        threadId={threadId!}
        dark={dark}
        flush={flush}
        zh={zh}
        onResolved={() => { void reload() }}
        onEnded={(info) => {
          setReportOffer({
            threadId: threadId!,
            loopId: info.loopId,
            childJobCount: info.childJobCount,
          })
        }}
        className={className}
      />
    )
  }
  if (busy) return null
  // HARD: while Subagents are live this round, do not nudge verify.
  if ((loop.liveSubagents ?? 0) > 0) return null
  if (loop.bucket === 'dispatch' || loop.bucket === 'verify') {
    if (!parentOk) {
      return (
        <SwitchToAgimDock
          dark={dark}
          flush={flush}
          zh={zh}
          agentId={agentId}
          workerHint={workerHint}
          onSwitchToAgimParent={onSwitchToAgimParent}
          className={className}
        />
      )
    }
    return (
      <ActNowDock
        loop={loop}
        dark={dark}
        flush={flush}
        zh={zh}
        preferredWorker={workerHint}
        onSend={onSend}
        className={className}
      />
    )
  }
  return null
})

function ConfirmMetDock({
  loop,
  threadId,
  dark,
  flush,
  zh,
  onResolved,
  onEnded,
  className,
}: {
  loop: LoopStatusDto
  threadId: string
  dark?: boolean
  flush?: boolean
  zh: boolean
  onResolved: () => void
  onEnded: (info: { loopId: string; childJobCount: number }) => void
  className?: string
}): JSX.Element {
  const pending = loop.pendingConfirmation
  const summary = (pending?.summary || loop.lastVerification?.summary || '').trim()
  const [supplement, setSupplement] = useState('')
  const [busyAction, setBusyAction] = useState<'end' | 'continue' | null>(null)

  async function submit(action: 'end' | 'continue') {
    if (busyAction) return
    setBusyAction(action)
    try {
      const res = await confirmLoopMet({
        threadId,
        action,
        supplement: supplement.trim() || undefined,
        lang: zh ? 'zh' : 'en',
      })
      // Pull the durable ended summary (written by confirm-met) into the
      // transcript — conclusion content is deferred until this click.
      if (action === 'end') {
        openChatWs().send({ type: 'get-history', threadId })
        const loopId = res.loop?.id || loop.id
        onEnded({
          loopId,
          childJobCount: typeof res.childJobCount === 'number'
            ? res.childJobCount
            : (loop.usage?.dispatchCount ?? 0),
        })
      }
      onResolved()
    } catch {
      setBusyAction(null)
    }
  }

  return (
    <div className={cn('relative z-20 pb-1 pt-0', flush ? 'px-0' : 'px-3 sm:px-4', className)}>
      <section
        className={cn(
          'mx-auto flex w-full max-w-2xl flex-col',
          'rounded-xl border shadow-[0_-6px_22px_rgba(15,23,42,0.10)] ring-1 ring-black/5',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200',
          dark
            ? 'border-teal-500/30 bg-zinc-950 text-zinc-100'
            : 'border-teal-300/70 bg-white text-zinc-800',
        )}
        aria-label={zh ? '确认结案' : 'Confirm conclusion'}
      >
        <div className={cn(
          'flex shrink-0 items-center gap-2 border-b px-3 py-2',
          dark ? 'border-teal-500/20 bg-teal-500/10' : 'border-teal-200 bg-teal-50',
        )}>
          <span className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
            dark ? 'bg-teal-500/20 text-teal-300' : 'bg-teal-100 text-teal-700',
          )}>
            <Check className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight">
              {zh ? '结论已就绪 — 请确认' : 'Conclusion ready — confirm'}
            </p>
            <p className={cn('truncate text-[11px]', dark ? 'text-zinc-400' : 'text-zinc-500')}>
              {zh
                ? `第 ${loop.round}/${loop.maxRounds} 轮 · Loop 尚未结束；确认后才会结案并写入结束摘要`
                : `R${loop.round}/${loop.maxRounds} · Loop still open; end summary posts after you confirm`}
            </p>
          </div>
        </div>

        <div className="space-y-2.5 px-3 py-3">
          <div
            data-testid="loop-confirm-summary"
            className={cn(
              'min-w-0 overflow-y-auto overflow-x-hidden rounded-lg px-2.5 py-2 text-sm leading-relaxed',
              CONFIRM_MET_SUMMARY_MAX_CLASS,
              dark ? 'bg-zinc-900 text-zinc-200' : 'bg-zinc-50 text-zinc-700',
            )}
          >
            {summary ? (
              <MarkdownView
                content={summary}
                className={cn(
                  'break-words text-sm leading-relaxed',
                  dark ? 'text-zinc-200' : 'text-zinc-700',
                )}
              />
            ) : (
              <span className={dark ? 'text-zinc-400' : 'text-zinc-500'}>
                {zh ? '（无摘要）' : '(no summary)'}
              </span>
            )}
          </div>
          {pending?.gaps?.length ? (
            <p className={cn('text-[11px]', dark ? 'text-zinc-400' : 'text-zinc-500')}>
              {zh ? '缺口：' : 'Gaps: '}{pending.gaps.join(zh ? '；' : '; ')}
            </p>
          ) : null}
          <label className="block space-y-1">
            <span className={cn('text-[11px] font-medium', dark ? 'text-zinc-300' : 'text-zinc-600')}>
              {zh ? '补充（可选）' : 'Supplement (optional)'}
            </span>
            <textarea
              value={supplement}
              onChange={(e) => setSupplement(e.target.value)}
              rows={2}
              placeholder={zh ? '例如：再核对一下持仓区间，或同意结案' : 'e.g. double-check range, or approve ending'}
              className={cn(
                'w-full resize-none rounded-lg border px-2.5 py-2 text-sm outline-none focus:border-teal-500',
                dark
                  ? 'border-zinc-700 bg-zinc-900 text-zinc-100 placeholder:text-zinc-500'
                  : 'border-zinc-200 bg-zinc-50 text-zinc-800 placeholder:text-zinc-400',
              )}
            />
          </label>
          <div className="flex justify-end gap-2 pt-0.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!!busyAction}
              onClick={() => void submit('continue')}
            >
              {zh ? '继续下一轮' : 'Continue'}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!!busyAction}
              onClick={() => void submit('end')}
              className="gap-1.5"
            >
              <Check className="h-3.5 w-3.5" />
              {zh ? '确认结束' : 'End Loop'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}

function ReportOfferDock({
  offer,
  dark,
  flush,
  zh,
  onSend,
  onDismiss,
  className,
}: {
  offer: ReportOffer
  dark?: boolean
  flush?: boolean
  zh: boolean
  onSend: (text: string) => void
  onDismiss: () => void
  className?: string
}): JSX.Element {
  const n = offer.childJobCount

  function askAgent() {
    onSend(buildLoopReportPrompt({
      loopId: offer.loopId,
      childJobCount: n,
      zh,
    }))
    onDismiss()
  }

  return (
    <div className={cn('relative z-20 pb-1 pt-0', flush ? 'px-0' : 'px-3 sm:px-4', className)}>
      <section
        className={cn(
          'mx-auto flex w-full max-w-2xl flex-col',
          'rounded-xl border shadow-[0_-6px_22px_rgba(15,23,42,0.10)] ring-1 ring-black/5',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200',
          dark
            ? 'border-teal-500/30 bg-zinc-950 text-zinc-100'
            : 'border-teal-300/70 bg-white text-zinc-800',
        )}
        aria-label={zh ? '生成详细报告' : 'Generate detail report'}
      >
        <div className={cn(
          'flex shrink-0 items-center gap-2 border-b px-3 py-2',
          dark ? 'border-teal-500/20 bg-teal-500/10' : 'border-teal-200 bg-teal-50',
        )}>
          <span className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
            dark ? 'bg-teal-500/20 text-teal-300' : 'bg-teal-100 text-teal-700',
          )}>
            <FileText className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight">
              {zh ? '是否生成详细分析报告？' : 'Generate a detailed report?'}
            </p>
            <p className={cn('truncate text-[11px]', dark ? 'text-zinc-400' : 'text-zinc-500')}>
              {zh
                ? `请 Agent 仅基于本 Loop${n > 0 ? `（约 ${n} 个子代理）` : ''}撰写并落盘`
                : `Ask the Agent to write & save a report for this Loop${n > 0 ? ` (~${n} subagents)` : ''}`}
            </p>
          </div>
        </div>

        <div className="space-y-2.5 px-3 py-3">
          <p className={cn('text-sm leading-relaxed', dark ? 'text-zinc-300' : 'text-zinc-600')}>
            {zh
              ? 'Loop 已结案。结束摘要偏短；同意后会向 Agent 发送一句总结指令，由其基于本 Loop 产出撰写详细报告（落盘 PROJECTS/loops/ 并在聊天展示）。'
              : 'Loop has ended. The summary is brief — agree to send the Agent one prompt to synthesize this Loop’s outputs into a detailed report (save under PROJECTS/loops/ and show in chat).'}
          </p>
          <div className="flex justify-end gap-2 pt-0.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onDismiss}
              className="gap-1.5"
            >
              <X className="h-3.5 w-3.5" />
              {zh ? '不需要' : 'Not now'}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={askAgent}
              className="gap-1.5"
            >
              <FileText className="h-3.5 w-3.5" />
              {zh ? '生成报告' : 'Generate report'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}

function AligningDock({
  loop,
  dark,
  flush,
  zh,
  onSend,
  parentOk = true,
  agentId,
  workerHint,
  onSwitchToAgimParent,
  className,
}: {
  loop: LoopStatusDto
  dark?: boolean
  flush?: boolean
  zh: boolean
  onSend: (text: string) => void
  parentOk?: boolean
  agentId?: string
  workerHint?: string
  onSwitchToAgimParent?: () => void
  className?: string
}): JSX.Element {
  const [objective, setObjective] = useState(loop.objective || '')
  const [exit, setExit] = useState(loop.exitDescription || '')
  const [body, setBody] = useState(loop.body || '')
  // Long Focus appendix in body: collapse by default so the sheet stays light.
  const [bodyOpen, setBodyOpen] = useState(() => (loop.body || '').length <= 240)

  useEffect(() => {
    setObjective(loop.objective || '')
    setExit(loop.exitDescription || '')
    setBody(loop.body || '')
  }, [loop.objective, loop.exitDescription, loop.body])

  const canConfirm = parentOk && objective.trim().length > 0 && exit.trim().length > 0
  const currentAgent = (agentId || '').trim() || (zh ? '当前 Agent' : 'current agent')
  const fieldClass = cn(
    'w-full resize-none rounded-lg border px-2.5 py-2 text-sm outline-none focus:border-teal-500',
    dark
      ? 'border-zinc-700 bg-zinc-900 text-zinc-100 placeholder:text-zinc-500'
      : 'border-zinc-200 bg-zinc-50 text-zinc-800 placeholder:text-zinc-400',
  )

  return (
    <div className={cn('relative z-20 pb-1 pt-0', flush ? 'px-0' : 'px-3 sm:px-4', className)}>
      <section
        className={cn(
          'mx-auto flex w-full max-w-2xl flex-col',
          'rounded-xl border shadow-[0_-6px_22px_rgba(15,23,42,0.10)] ring-1 ring-black/5',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200',
          dark
            ? 'border-amber-500/30 bg-zinc-950 text-zinc-100'
            : 'border-amber-300/60 bg-white text-zinc-800',
        )}
        aria-label={zh ? 'Loop 对焦' : 'Loop aligning'}
      >
        <div className={cn(
          'flex shrink-0 items-center gap-2 border-b px-3 py-2',
          dark ? 'border-amber-500/20 bg-amber-500/10' : 'border-amber-200 bg-amber-50',
        )}>
          <span className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
            dark ? 'bg-amber-500/20 text-amber-300' : 'bg-amber-100 text-amber-700',
          )}>
            <Target className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight">
              {zh ? '待对焦 — 补充目标与退出条件' : 'Aligning — set objective & exit'}
            </p>
            <p className={cn('truncate text-[11px]', dark ? 'text-zinc-400' : 'text-zinc-500')}>
              {zh ? '正文可选；确认后才会派子代理' : 'Body optional; Subagents blocked until confirmed'}
            </p>
          </div>
        </div>

        {!parentOk ? (
          <div className={cn(
            'flex flex-wrap items-center gap-2 border-b px-3 py-2',
            dark ? 'border-rose-500/20 bg-rose-500/10' : 'border-rose-200 bg-rose-50',
          )}>
            <p className={cn(
              'min-w-0 flex-1 text-[11px] leading-snug',
              dark ? 'text-rose-200' : 'text-rose-800',
            )}>
              {zh
                ? `Loop 父编排须用 Agim（当前：${currentAgent}）。切回后可优先派 ${workerHint || currentAgent} 干活。`
                : `Loop parent must be Agim (current: ${currentAgent}). After switch, prefer ${workerHint || currentAgent} as Subagent.`}
            </p>
            {onSwitchToAgimParent ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={onSwitchToAgimParent}
                className="shrink-0"
              >
                {zh ? '用 Agim 编排' : 'Use Agim parent'}
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-2.5 px-3 py-3">
          <label className="block space-y-1">
            <span className={cn('text-[11px] font-medium', dark ? 'text-zinc-300' : 'text-zinc-600')}>
              {zh ? '目标' : 'Objective'}
            </span>
            <textarea
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              rows={2}
              placeholder={zh ? '例如：修好登录超时并通过回归' : 'e.g. Fix login timeout and pass regression'}
              className={fieldClass}
            />
          </label>
          <label className="block space-y-1">
            <span className={cn('text-[11px] font-medium', dark ? 'text-zinc-300' : 'text-zinc-600')}>
              {zh ? '退出条件' : 'Exit condition'}
            </span>
            <textarea
              value={exit}
              onChange={(e) => setExit(e.target.value)}
              rows={2}
              placeholder={zh ? '例如：验收通过或最多3轮' : 'e.g. Acceptance pass or max 3 rounds'}
              className={fieldClass}
            />
          </label>
          <div className="block space-y-1">
            <button
              type="button"
              onClick={() => setBodyOpen((v) => !v)}
              className={cn(
                'flex w-full items-center justify-between text-left text-[11px] font-medium',
                dark ? 'text-zinc-300' : 'text-zinc-600',
              )}
            >
              <span>{zh ? '正文（可选）' : 'Body (optional)'}</span>
              <span className={cn('font-normal', dark ? 'text-zinc-500' : 'text-zinc-400')}>
                {bodyOpen
                  ? (zh ? '收起' : 'Hide')
                  : (zh ? `展开${body.trim() ? ` · ${body.trim().length} 字` : ''}` : `Show${body.trim() ? ` · ${body.trim().length} chars` : ''}`)}
              </span>
            </button>
            {bodyOpen ? (
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                placeholder={zh
                  ? '例如：优先查超时日志；对照上周回归清单；不要改鉴权配置'
                  : 'e.g. Check timeout logs first; follow last week’s checklist; do not touch auth config'}
                className={fieldClass}
              />
            ) : null}
          </div>
          <div className="flex justify-end pt-0.5">
            <Button
              type="button"
              size="sm"
              disabled={!canConfirm}
              onClick={() => onSend(buildAlignPayload(objective, exit, body))}
              className="gap-1.5"
            >
              <Compass className="h-3.5 w-3.5" />
              {zh ? '确定并开始' : 'Confirm & start'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  )
}

function SwitchToAgimDock({
  dark,
  flush,
  zh,
  agentId,
  workerHint,
  onSwitchToAgimParent,
  className,
}: {
  dark?: boolean
  flush?: boolean
  zh: boolean
  agentId?: string
  workerHint?: string
  onSwitchToAgimParent?: () => void
  className?: string
}): JSX.Element {
  const current = (agentId || '').trim() || (zh ? '当前 Agent' : 'current agent')
  const worker = workerHint || current
  const title = zh ? '用 Agim 编排，派 CLI 干活' : 'Agim orchestrates; CLI works'
  const body = zh
    ? `当前是 ${current}。切到 Agim 作父编排后，会优先用 call_agents 派 ${worker}。`
    : `Current agent is ${current}. Switch to Agim as parent — call_agents will prefer ${worker}.`

  return (
    <div className={cn('relative z-20 pb-1 pt-0', flush ? 'px-0' : 'px-3 sm:px-4', className)}>
      <section
        className={cn(
          'mx-auto flex w-full max-w-2xl items-center gap-2 rounded-xl border px-3 py-2.5',
          'shadow-[0_-6px_22px_rgba(15,23,42,0.10)] ring-1 ring-black/5',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200',
          dark ? 'border-rose-500/30 bg-zinc-950' : 'border-rose-300/70 bg-white',
        )}
        aria-label={title}
      >
        <span className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          dark ? 'bg-rose-500/20 text-rose-300' : 'bg-rose-100 text-rose-700',
        )}>
          <X className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-semibold', dark ? 'text-zinc-100' : 'text-zinc-800')}>
            {title}
          </p>
          <p className={cn('mt-0.5 text-[11px] leading-snug', dark ? 'text-zinc-400' : 'text-zinc-500')}>
            {body}
          </p>
        </div>
        {onSwitchToAgimParent ? (
          <Button
            type="button"
            size="sm"
            onClick={onSwitchToAgimParent}
            className="shrink-0 gap-1"
          >
            {zh ? '用 Agim 编排' : 'Use Agim'}
          </Button>
        ) : null}
      </section>
    </div>
  )
}

function ActNowDock({
  loop,
  dark,
  flush,
  zh,
  preferredWorker,
  onSend,
  className,
}: {
  loop: LoopStatusDto
  dark?: boolean
  flush?: boolean
  zh: boolean
  preferredWorker?: string
  onSend: (text: string) => void
  className?: string
}): JSX.Element {
  const waitingVerify = loop.bucket === 'verify'
  const title = waitingVerify
    ? (zh ? '待验收 — 立即推进' : 'Awaiting verify — act now')
    : (zh ? '待派工 — 立即行动' : 'Awaiting dispatch — act now')
  const subtitle = waitingVerify
    ? (zh ? '让 Agent 调用 loop_verdict 对照目标验收' : 'Ask the agent to call loop_verdict')
    : preferredWorker
      ? (zh ? `优先派 ${preferredWorker} 子代理` : `Prefer Subagent ${preferredWorker}`)
      : (zh ? '让 Agent 拆解并用 call_agents 派子代理' : 'Ask the agent to decompose and call_agents')
  const cta = zh ? '立即行动' : 'Act now'
  const obj = (loop.objective || '').trim()
  const short = obj.length > 48 ? `${obj.slice(0, 48)}…` : obj

  return (
    <div className={cn('relative z-20 pb-1 pt-0', flush ? 'px-0' : 'px-3 sm:px-4', className)}>
      <section
        className={cn(
          'mx-auto flex w-full max-w-2xl items-center gap-2 rounded-xl border px-3 py-2.5',
          'shadow-[0_-6px_22px_rgba(15,23,42,0.10)] ring-1 ring-black/5',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200',
          waitingVerify
            ? (dark ? 'border-sky-500/30 bg-zinc-950' : 'border-sky-300/70 bg-white')
            : (dark ? 'border-emerald-500/30 bg-zinc-950' : 'border-emerald-300/70 bg-white'),
        )}
        aria-label={title}
      >
        <span className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          waitingVerify
            ? (dark ? 'bg-sky-500/20 text-sky-300' : 'bg-sky-100 text-sky-700')
            : (dark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-700'),
        )}>
          <Play className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-semibold', dark ? 'text-zinc-100' : 'text-zinc-800')}>
            {title}
          </p>
          <p className={cn('truncate text-[11px]', dark ? 'text-zinc-400' : 'text-zinc-500')}>
            {short || subtitle}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => onSend(actNowPrompt(loop, zh, preferredWorker))}
          className="shrink-0 gap-1"
        >
          <Play className="h-3.5 w-3.5" />
          {cta}
        </Button>
      </section>
    </div>
  )
}
