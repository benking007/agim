/**
 * ApprovalDock — floating panel for pending approval cards (v1.2.115).
 *
 * Before this iteration, approval cards rendered inline in the chat
 * message stream and resolved cards lingered as "✅ Allowed · WEB"
 * badges sandwiched between assistant replies. Two problems:
 *   1. Chat history was visually cluttered — every tool call left a
 *      stale terminal-state row behind.
 *   2. Active cards were buried below the latest assistant reply, so
 *      the user had to scroll back to find them.
 *
 * Dock semantics:
 *   - Renders only PENDING cards (and briefly the just-resolved ones
 *     for the badge transition, then they auto-dismiss).
 *   - Stacked vertically above the chat input; max-height 240px with
 *     an inner scroll so a flood of concurrent approvals doesn't push
 *     the chat list off-screen.
 *   - Click → optimistic disabled state ("已发送…") via per-row
 *     `pendingChoice` local state. Outcome arrives → row swaps to
 *     OutcomeBadge → setTimeout in use-chat.ts dismisses the row.
 *
 * Why all rows are unconditional disclosure (no collapse): users
 * explicitly need to act on every one; hiding any of them risks
 * stalling the agent loop. The 240px scroll cap is the safety valve.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'

import type { ApprovalChoice, PendingApproval } from '@/hooks/use-chat'
import type { ApprovalCardOutcome } from '@/types/ws'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface ApprovalDockProps {
  approvals: PendingApproval[]
  onApprove: (messageId: string, reqId: string, choice: ApprovalChoice) => boolean | undefined
}

export function ApprovalDock({ approvals, onApprove }: ApprovalDockProps): JSX.Element | null {
  if (approvals.length === 0) return null
  return (
    <div className="border-t border-warning/40 bg-warning-bg/40">
      <div className="mx-auto max-h-60 w-full max-w-3xl overflow-y-auto px-3 py-2 sm:px-4">
        <div className="flex flex-col gap-2">
          {approvals.map((a) => (
            <DockRow key={a.messageId} entry={a} onApprove={onApprove} />
          ))}
        </div>
      </div>
    </div>
  )
}

interface DockRowProps {
  entry: PendingApproval
  onApprove: (messageId: string, reqId: string, choice: ApprovalChoice) => boolean | undefined
}

function DockRow({ entry, onApprove }: DockRowProps): JSX.Element {
  const { t } = useTranslation()
  const { messageId, prompt, outcome } = entry
  const isAuto = prompt.mode === 'auto-allow'
  const isExplicit = prompt.mode === 'explicit'

  // v1.2.88 optimistic submitting state — kept for the dock so the
  // user gets immediate feedback on click. Cleared when the outcome
  // arrives (use-chat dismisses the row shortly after).
  const [pendingChoice, setPendingChoice] = useState<ApprovalChoice | null>(null)
  useEffect(() => { if (outcome) setPendingChoice(null) }, [outcome])

  function handleClick(choice: ApprovalChoice): void {
    if (pendingChoice || !onApprove) return
    setPendingChoice(choice)
    const ok = onApprove(messageId, prompt.reqId, choice)
    if (ok === false) setPendingChoice(null)
  }

  return (
    <div
      className={cn(
        'rounded-lg border bg-surface p-3 shadow-sm transition-opacity',
        outcome ? 'border-success/60 opacity-80' : 'border-warning',
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <Badge variant="warning" className="gap-1">
          <ShieldCheck className="h-3 w-3" />
          {t('chat.approvalTitle')}
        </Badge>
        {isAuto && !outcome && (
          <Badge variant="outline" className="text-[10px] uppercase">
            {t('chat.approvalAutoBadge', { defaultValue: 'auto-allow' })}
          </Badge>
        )}
        {isExplicit && !outcome && (
          <Badge variant="outline" className="text-[10px] uppercase">
            {t('chat.approvalExplicitBadge', { defaultValue: 'one-time decision' })}
          </Badge>
        )}
        {isAuto && !outcome && prompt.graceSeconds != null && (
          <AutoAllowCountdown graceSeconds={prompt.graceSeconds} />
        )}
        <code className="ml-auto rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
          {prompt.toolName}
        </code>
      </div>

      <pre className="mb-2 max-h-32 overflow-auto rounded bg-surface-2 p-2 font-mono text-xs leading-relaxed text-text">
        {prompt.inputJson}
      </pre>

      {outcome ? (
        <OutcomeBadge outcome={outcome} />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {!isAuto && (
              <Button
                size="sm"
                disabled={pendingChoice !== null}
                onClick={() => handleClick('y')}
              >
                {t('chat.approvalAllow')}
              </Button>
            )}
            {!isAuto && !isExplicit && (
              <Button
                size="sm"
                variant="secondary"
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
              disabled={pendingChoice !== null}
              onClick={() => handleClick('n')}
            >
              {t('chat.approvalDeny')}
            </Button>
          </div>
          {pendingChoice !== null && (
            <p className="mt-1.5 text-xs text-text-dim">
              {t('chat.approvalSubmitting')}
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** Mirrors message-bubble.tsx's countdown — kept inline to avoid a
 *  cross-module import dependency. The bus-side timer is authoritative;
 *  this just paints a visual cue. */
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
    <span className="text-xs text-warning">
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
      return <Badge variant="success">{t('chat.outcome.allowed', { defaultValue: '✅ Allowed' })}{by}</Badge>
    case 'allowed-pinned':
      return <Badge variant="success">{t('chat.outcome.allowedPinned', { defaultValue: '✅ Allowed + auto-allow further' })}{by}</Badge>
    case 'denied':
      return <Badge variant="danger">{t('chat.outcome.denied', { defaultValue: '❌ Denied' })}{by}</Badge>
    case 'denied-revoked':
      return <Badge variant="danger">{t('chat.outcome.deniedRevoked', { defaultValue: '❌ Denied (auto-allow revoked)' })}{by}</Badge>
    case 'expired':
      return <Badge variant="outline">{t('chat.outcome.expired', { defaultValue: '⏱ Timed out' })}{by}</Badge>
  }
}
