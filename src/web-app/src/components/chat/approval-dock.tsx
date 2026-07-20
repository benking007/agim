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
    <div className={cn('relative z-20 pb-1.5 pt-0', flush ? 'px-0' : 'px-3 sm:px-4')}>
      <section
        className={cn(
          'mx-auto flex w-full max-w-3xl flex-col',
          'max-h-[min(52vh,28rem)]',
          'rounded-2xl border border-warning/30 bg-surface',
          'shadow-[0_-8px_30px_rgba(15,23,42,0.12)]',
          'ring-1 ring-black/5',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200',
        )}
        aria-label={t('chat.approvalTitle', { defaultValue: 'Tool approval' })}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-warning/15 bg-warning-bg px-4 py-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning/15 text-warning">
            <ShieldAlert className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold tracking-tight text-text">
              {t('chat.approvalTitle', { defaultValue: 'Tool approval' })}
            </p>
            <p className="truncate text-xs text-text-dim">
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
            <Badge variant="warning" className="shrink-0 tabular-nums">
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
  const formatted = useMemo(() => prettyJson(prompt.inputJson), [prompt.inputJson])

  const [pendingChoice, setPendingChoice] = useState<ApprovalChoice | null>(null)
  useEffect(() => { if (outcome) setPendingChoice(null) }, [outcome])

  function handleClick(choice: ApprovalChoice): void {
    if (pendingChoice || !onApprove) return
    setPendingChoice(choice)
    const ok = onApprove(messageId, prompt.reqId, choice)
    if (ok === false) setPendingChoice(null)
  }

  return (
    <div className={cn('flex flex-col transition-opacity', outcome && 'opacity-80')}>
      <div className="px-4 pt-4">
        {stacked && (
          <div className="mb-1.5 flex items-center gap-1.5 text-xs text-text-dim">
            <ShieldCheck className="h-3.5 w-3.5 text-warning" />
            {t('chat.approvalTitle', { defaultValue: 'Tool approval' })}
          </div>
        )}
        <code className="block truncate agim-mono text-[15px] font-semibold tracking-tight text-text">
          {prompt.toolName}
        </code>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {isAuto && !outcome && (
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
              {t('chat.approvalAutoBadge', { defaultValue: 'auto-allow' })}
            </Badge>
          )}
          {isExplicit && !outcome && (
            <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
              {t('chat.approvalExplicitBadge', { defaultValue: 'one-time decision' })}
            </Badge>
          )}
          {isAuto && !outcome && prompt.graceSeconds != null && (
            <AutoAllowCountdown graceSeconds={prompt.graceSeconds} />
          )}
        </div>

        <pre className="mt-3 max-h-36 overflow-auto rounded-xl border border-border/70 bg-bg/80 px-3.5 py-3 agim-mono text-[12px] leading-relaxed text-text-dim sm:text-[13px]">
          {formatted}
        </pre>
      </div>

      <div className="sticky bottom-0 mt-3 border-t border-border/60 bg-surface/95 px-4 py-3 backdrop-blur-sm">
        {outcome ? (
          <OutcomeBadge outcome={outcome} />
        ) : (
          <>
            <div
              className={cn(
                'grid gap-2',
                isAuto
                  ? 'grid-cols-1'
                  : isExplicit
                    ? 'grid-cols-2'
                    : 'grid-cols-1 sm:grid-cols-[1.4fr_1fr_1fr]',
              )}
            >
              {!isAuto && (
                <Button
                  className="min-h-12 w-full text-sm font-semibold"
                  disabled={pendingChoice !== null}
                  onClick={() => handleClick('y')}
                >
                  {t('chat.approvalAllow')}
                </Button>
              )}
              {!isAuto && !isExplicit && (
                <Button
                  variant="secondary"
                  className="min-h-12 w-full"
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
                variant="destructive"
                className="min-h-12 w-full"
                disabled={pendingChoice !== null}
                onClick={() => handleClick('n')}
              >
                {t('chat.approvalDeny')}
              </Button>
            </div>
            {pendingChoice !== null && (
              <p className="mt-2 text-xs text-text-dim">
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
  const by = outcome.byUserDisplay ? ` | ${outcome.byUserDisplay}` : ''
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
