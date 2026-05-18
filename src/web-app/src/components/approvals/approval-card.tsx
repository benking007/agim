/**
 * ApprovalCard — one HITL approval, rendered as a card.
 *
 * The /approvals route uses cards (not table rows) on purpose:
 *   * approvals are time-sensitive and few — visual urgency matters
 *   * each row's `input` is a free-form record that's hard to squeeze
 *     into a single cell. The card body has room for a JSON preview.
 *   * Allow / Deny are 1-click decisions; we want big tap targets
 *     even on desktop, which doesn't fit cleanly into a TableCell.
 *
 * Layout:
 *   ┌─ tool name · platform · age ─────────────────┐
 *   │ thread id (monospaced)                       │
 *   │                                              │
 *   │ <pre>input json (truncated to ~12 lines)</pre>│
 *   │                                              │
 *   │                       [ Deny ]  [ Allow ]    │
 *   └──────────────────────────────────────────────┘
 *
 * The buttons are disabled while a resolution is in flight (so a
 * second click can't double-fire). Async failure surfaces via the
 * parent's toast; the card stays put.
 */

import { useTranslation } from 'react-i18next'
import { Check, X, AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Approval, ApprovalBehavior } from '@/types/api'

export interface ApprovalCardProps {
  approval: Approval
  /** Async resolve callback. The card calls this with the behavior
   *  + the current reqId; parent handles toast + mutation state.
   *  The card disables its buttons while the promise is in flight. */
  onResolve: (behavior: ApprovalBehavior) => Promise<void> | void
  /** When true, both action buttons are disabled. Parent flips this
   *  on while its mutation is in flight. */
  busy?: boolean
  /** Optional className for the outer card. */
  className?: string
}

export function ApprovalCard({
  approval,
  onResolve,
  busy = false,
  className,
}: ApprovalCardProps): JSX.Element {
  const { t } = useTranslation('approvals')

  const aged = formatAge(approval.ageMs)
  const inputPreview = previewJson(approval.input, 12)

  return (
    <div
      className={cn(
        'flex flex-col gap-3',
        'rounded-md border bg-surface p-4',
        // Cards older than 90s carry a soft danger border to draw
        // the operator's eye to stale requests.
        approval.ageMs > 90_000 ? 'border-danger/60' : 'border-border',
        className,
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-text">{approval.toolName}</span>
        <Badge variant="secondary">{approval.platform}</Badge>
        {approval.autoAllow && (
          <Badge variant="info" title={t('autoAllowedTitle')}>
            {t('autoAllowedTag')}
          </Badge>
        )}
        <span className="ml-auto inline-flex items-center gap-1 text-xs text-text-dim">
          {approval.ageMs > 90_000 && <AlertTriangle className="h-3 w-3 text-danger" />}
          {aged}
        </span>
      </header>

      <div className="flex flex-col gap-1 text-xs">
        <div className="text-text-muted">{t('threadLabel')}</div>
        <code
          className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs text-text-dim line-clamp-1"
          title={approval.threadId}
        >
          {approval.threadId}
        </code>
      </div>

      <pre
        className={cn(
          'max-h-48 overflow-auto rounded-md',
          'bg-surface-2 px-2 py-2',
          'font-mono text-xs leading-5 text-text-dim',
          'whitespace-pre-wrap break-words',
        )}
      >
        {inputPreview}
      </pre>

      <footer className="flex justify-end gap-2">
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={busy}
          onClick={() => void onResolve('deny')}
        >
          <X className="h-4 w-4" />
          {t('deny')}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={busy}
          onClick={() => void onResolve('allow')}
        >
          <Check className="h-4 w-4" />
          {t('allow')}
        </Button>
      </footer>
    </div>
  )
}

/** Human-readable age string ("12s", "4m", "2h"). Tracks the
 *  bus's ageMs at render time; SSE invalidation keeps it fresh. */
function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h`
}

/** Pretty-print the tool input JSON with a line cap. Falls back to
 *  `String(value)` if JSON.stringify throws (e.g. circular). */
function previewJson(value: unknown, maxLines: number): string {
  let text: string
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  const lines = text.split('\n')
  if (lines.length <= maxLines) return text
  return `${lines.slice(0, maxLines).join('\n')}\n… +${lines.length - maxLines} more`
}
