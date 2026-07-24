/**
 * ApprovalDock — floating action sheet for pending tool approvals.
 *
 * Elevated card above the composer (not a full-bleed border-t strip).
 * Header + actions stay pinned; only the tool/JSON body scrolls when
 * content is tall — so Allow/Deny never get clipped on short phones.
 */

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert, ShieldCheck, Timer } from 'lucide-react'

import type { ApprovalChoice, PendingApproval } from '@/hooks/use-chat'
import type { ApprovalCardOutcome } from '@/types/ws'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface ApprovalDockProps {
  approvals: PendingApproval[]
  onApprove: (messageId: string, reqId: string, choice: ApprovalChoice) => boolean | undefined
  /** Skip outer horizontal padding when the parent already insets. */
  flush?: boolean
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export function ApprovalDock({ approvals, onApprove, flush }: ApprovalDockProps): JSX.Element | null {
  const { t } = useTranslation()
  if (approvals.length === 0) return null

  return (
    <div className={cn('relative z-20 pb-1 pt-0', flush ? 'px-0' : 'px-3 sm:px-4')}>
      <section
        className={cn(
          'mx-auto flex w-full max-w-2xl flex-col',
          'max-h-[min(44vh,22rem)]',
          'rounded-xl border border-warning/30 bg-surface',
          'shadow-[0_-6px_22px_rgba(15,23,42,0.10)]',
          'ring-1 ring-black/5',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200',
        )}
        aria-label={t('chat.approvalTitle', { defaultValue: 'Tool approval' })}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-warning/15 bg-warning-bg px-3 py-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
            <ShieldAlert className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold tracking-tight text-text">
              {t('chat.approvalTitle', { defaultValue: 'Tool approval' })}
            </p>
            <p className="truncate text-[11px] text-text-dim">
              {approvals.length > 1
                ? t('chat.approvalPendingCount', {
                    count: approvals.length,
                    defaultValue: '{{count}} pending decisions',
                  })
                : t('chat.approvalSubtitle', {
                    defaultValue: 'Review the tool call before it continues',
                  })}
            </p>
          </div>
          {approvals.length > 1 && (
            <Badge variant="warning" className="shrink-0 tabular-nums text-[10px]">
              {approvals.length}
            </Badge>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col divide-y divide-border/70">
            {approvals.map((a) => (
              <DockRow
                key={a.messageId}
                entry={a}
                onApprove={onApprove}
                stacked={approvals.length > 1}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

interface DockRowProps {
  entry: PendingApproval
  onApprove: (messageId: string, reqId: string, choice: ApprovalChoice) => boolean | undefined
  stacked: boolean
}

function DockRow({ entry, onApprove, stacked }: DockRowProps): JSX.Element {
  const { t } = useTranslation()
  const { messageId, prompt, outcome } = entry
  const isAuto = prompt.mode === 'auto-allow'
  const isExplicit = prompt.mode === 'explicit'
  const canPin = Boolean(prompt.canPin) || !isExplicit
  const showAuto = !isAuto && canPin
  const formatted = useMemo(() => prettyJson(prompt.inputJson), [prompt.inputJson])

  const [pendingChoice, setPendingChoice] = useState<ApprovalChoice | null>(null)
  useEffect(() => { if (outcome) setPendingChoice(null) }, [outcome])

  function handleClick(choice: ApprovalChoice): void {
    if (pendingChoice || !onApprove) return
    setPendingChoice(choice)
    const ok = onApprove(messageId, prompt.reqId, choice)
    if (ok === false) setPendingChoice(null)
  }

  const originLabel = prompt.originLabel
    || (typeof prompt.callDepth === 'number' && prompt.callDepth > 0
      ? t('chat.approvalOriginSubagent', {
          agent: prompt.callerAgent || 'agent',
          defaultValue: 'Subagent · {{agent}}',
        })
      : null)

  return (
    <div className={cn('flex flex-col transition-opacity', outcome && 'opacity-80')}>
      <div className="px-3 pt-2.5">
        {stacked && (
          <div className="mb-1 flex items-center gap-1 text-[11px] text-text-dim">
            <ShieldCheck className="h-3 w-3 text-warning" />
            {t('chat.approvalTitle', { defaultValue: 'Tool approval' })}
          </div>
        )}
        <code className="block truncate agim-mono text-[13px] font-semibold tracking-tight text-text">
          {prompt.toolName}
        </code>
        {originLabel && (
          <p className="mt-0.5 truncate text-[11px] text-text-muted">
            {originLabel}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {isAuto && !outcome && (
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
              {t('chat.approvalAutoBadge', { defaultValue: 'auto-allow' })}
            </Badge>
          )}
          {isExplicit && !outcome && (
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
              {prompt.canPin
                ? t('chat.approvalNeedsConfirmBadge', { defaultValue: 'needs confirmation' })
                : t('chat.approvalExplicitBadge', { defaultValue: 'one-time decision' })}
            </Badge>
          )}
          {isAuto && !outcome && prompt.graceSeconds != null && (
            <AutoAllowCountdown graceSeconds={prompt.graceSeconds} />
          )}
        </div>

        <pre className="mt-2 max-h-28 overflow-auto rounded-lg border border-border/70 bg-bg/80 px-2.5 py-2 agim-mono text-[11px] leading-relaxed text-text-dim sm:text-[12px]">
          {formatted}
        </pre>
      </div>

      <div className="sticky bottom-0 mt-2 border-t border-border/60 bg-surface/95 px-3 py-2 backdrop-blur-sm">
        {outcome ? (
          <OutcomeBadge outcome={outcome} />
        ) : (
          <>
            <div
              className={cn(
                'grid gap-1.5',
                isAuto
                  ? 'grid-cols-1'
                  : showAuto
                    ? 'grid-cols-1 sm:grid-cols-[1.3fr_1fr_1fr]'
                    : 'grid-cols-2',
              )}
            >
              {!isAuto && (
                <Button
                  size="sm"
                  className="min-h-8 w-full text-xs font-semibold"
                  disabled={pendingChoice !== null}
                  onClick={() => handleClick('y')}
                >
                  {t('chat.approvalAllow')}
                </Button>
              )}
              {showAuto && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="min-h-8 w-full text-xs"
                  disabled={pendingChoice !== null}
                  onClick={() => handleClick('a')}
                  title={t('chat.approvalAutoTip', {
                    defaultValue: 'Allow and auto-allow similar calls for the rest of the session',
                  })}
                >
                  {t('chat.approvalAuto')}
                </Button>
              )}
              <Button
                size="sm"
                variant="destructive"
                className="min-h-8 w-full text-xs"
                disabled={pendingChoice !== null}
                onClick={() => handleClick('n')}
              >
                {t('chat.approvalDeny')}
              </Button>
            </div>
            {pendingChoice !== null && (
              <p className="mt-1.5 text-[11px] text-text-dim">
                {t('chat.approvalSubmitting')}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function AutoAllowCountdown({ graceSeconds }: { graceSeconds: number }): JSX.Element | null {
  const { t } = useTranslation()
  const [remaining, setRemaining] = useState(Math.max(0, graceSeconds))
  useEffect(() => {
    if (graceSeconds <= 0) return
    setRemaining(graceSeconds)
    const id = setInterval(() => {
      setRemaining((s) => (s > 0 ? s - 1 : 0))
    }, 1000)
    return () => clearInterval(id)
  }, [graceSeconds])
  if (graceSeconds <= 0) return null
  return (
    <span className="inline-flex items-center gap-1 text-xs text-warning">
      <Timer className="h-3 w-3" />
      {remaining > 0
        ? t('chat.approvalAutoIn', {
            count: remaining,
            defaultValue: 'Auto-allowing in {{count}}s — Deny to stop.',
          })
        : t('chat.approvalAutoResolving', { defaultValue: 'Auto-allowing now…' })}
    </span>
  )
}

function OutcomeBadge({ outcome }: { outcome: ApprovalCardOutcome }): JSX.Element {
  const { t } = useTranslation()
  const by = outcome.byUserDisplay ? ` · ${outcome.byUserDisplay}` : ''
  switch (outcome.decision) {
    case 'allowed':
      return <Badge variant="success">{t('chat.outcome.allowed', { defaultValue: 'Allowed' })}{by}</Badge>
    case 'allowed-pinned':
      return <Badge variant="success">{t('chat.outcome.allowedPinned', { defaultValue: 'Allowed + auto-allow further' })}{by}</Badge>
    case 'denied':
      return <Badge variant="danger">{t('chat.outcome.denied', { defaultValue: 'Denied' })}{by}</Badge>
    case 'denied-revoked':
      return <Badge variant="danger">{t('chat.outcome.deniedRevoked', { defaultValue: 'Denied (auto-allow revoked)' })}{by}</Badge>
    case 'expired':
      return <Badge variant="outline">{t('chat.outcome.expired', { defaultValue: 'Timed out' })}{by}</Badge>
  }
}
