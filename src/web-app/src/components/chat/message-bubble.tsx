/**
 * MessageBubble — one chat message (user, assistant, or system/approval).
 *
 * Approval cards are rendered with the same structure as v1's
 * index.html:renderApprovalCard:
 *   * Title row
 *   * `auto-allow` mode gets a countdown row (graceSeconds → live
 *     ticker until the bus auto-resolves)
 *   * Tool name + Input JSON in dedicated rows (the input goes into a
 *     scrollable <pre> so an inputJson of a few hundred chars doesn't
 *     blow out the layout)
 *   * Three action buttons: Allow / Auto-allow / Deny (auto-allow mode
 *     hides Allow and Auto-allow because the bus is going to auto-allow
 *     anyway — only Deny is meaningful)
 *   * Once resolved, the buttons are replaced with a coloured outcome
 *     line that reflects all 5 decision states with optional byUser
 *
 * No markdown for now — plain text + preserved whitespace is correct
 * enough for agim's debugging-focused chat surface.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { MarkdownView } from '@/components/chat/markdown-view'
import { agentDisplayName } from '@/lib/agent-label'
import { cn } from '@/lib/utils'
import type { ChatMessage, ApprovalChoice } from '@/hooks/use-chat'
import type { ApprovalCardOutcome } from '@/types/ws'

export interface MessageBubbleProps {
  msg: ChatMessage
  /** Returns whether the WS click was actually transmitted. The
   *  approval card uses this to revert its optimistic "submitting"
   *  state when the socket is disconnected. */
  onApprove?: (messageId: string, reqId: string, choice: ApprovalChoice) => boolean | void
}

export function MessageBubble({ msg, onApprove }: MessageBubbleProps): JSX.Element {
  if (msg.approval) {
    return <ApprovalView approval={msg.approval} onApprove={onApprove} />
  }

  const isUser = msg.role === 'user'
  // Assistant replies can be copied as raw markdown (tables/code survive).
  const canCopy = !isUser && !!msg.content
  const displayAgent = msg.agent ? agentDisplayName(msg.agent) : ''
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] sm:max-w-[75%] rounded-lg px-3 py-2 shadow-sm',
          isUser
            ? 'bg-accent text-accent-fg'
            : 'bg-surface text-text border border-border',
        )}
      >
        {!isUser && (msg.agent || canCopy) && (
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-text-muted">{displayAgent}</span>
            {canCopy && <CopyButton text={msg.content} />}
          </div>
        )}
        {/* v1.2.116 — render assistant responses as markdown (GFM:
            tables, code, headings, lists). User input stays plain so
            their typed `**foo**` survives verbatim. Empty assistant
            content during streaming startup shows the … placeholder. */}
        {!isUser && msg.content ? (
          <MarkdownView content={msg.content} className="break-words" />
        ) : (
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
            {msg.content || (msg.role === 'assistant' && (
              <span className="inline-block animate-pulse text-text-dim">…</span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Copy the assistant message's raw markdown to the clipboard. Always
 *  visible (works on touch — no hover dependency) and gives transient
 *  "已复制" feedback. */
function CopyButton({ text }: { text: string }): JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  async function handleCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('chat.copyFailed'))
    }
  }
  return (
    <button
      type="button"
      onClick={handleCopy}
      title={t('chat.copyMarkdown')}
      className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-dim transition hover:bg-surface-2 hover:text-text"
    >
      {copied
        ? t('chat.copied')
        : t('chat.copy')}
    </button>
  )
}

/* ─────────── Approval card ─────────── */

interface ApprovalViewProps {
  approval: NonNullable<ChatMessage['approval']>
  onApprove?: (messageId: string, reqId: string, choice: ApprovalChoice) => boolean | void
}

function ApprovalView({ approval, onApprove }: ApprovalViewProps): JSX.Element {
  const { t } = useTranslation()
  const { messageId, prompt, text, outcome } = approval
  const isAuto = prompt?.mode === 'auto-allow'

  // v1.2.88 — optimistic "submitting" state. Without this, a click
  // produced ZERO visible feedback until the server pushed
  // `approval-card-edit` back (typically tens to hundreds of ms,
  // sometimes longer when the agent is busy). The user perceived
  // this as "the button didn't work" and would click again. Now we
  // disable both buttons and surface a "已发送" hint the instant a
  // click fires. If `onApprove` reports the WS send failed, we
  // revert so the user can retry once reconnected.
  const [pendingChoice, setPendingChoice] = useState<ApprovalChoice | null>(null)

  // Reset the optimistic state when the server's outcome lands — the
  // outer branch will take over rendering anyway, but this keeps the
  // component state hygienic if the card stays mounted.
  useEffect(() => {
    if (outcome) setPendingChoice(null)
  }, [outcome])

  function handleClick(choice: ApprovalChoice): void {
    if (pendingChoice || !prompt || !onApprove) return
    setPendingChoice(choice)
    const ok = onApprove(messageId, prompt.reqId, choice)
    // `void` return from the legacy v1 wiring counts as success — only
    // explicit `false` (from the use-chat hook) means the WS dropped it.
    if (ok === false) setPendingChoice(null)
  }

  return (
    <div
      className={cn(
        'mx-auto w-full max-w-2xl rounded-lg border p-4',
        isAuto ? 'border-warning/60 bg-warning-bg' : 'border-warning bg-warning-bg',
        outcome && 'opacity-90',
      )}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Badge variant="warning">
          {t('chat.approvalTitle', { defaultValue: '🔐 Tool approval' })}
        </Badge>
        {isAuto && !outcome && (
          <Badge variant="outline" className="text-[10px] uppercase">
            {t('chat.approvalAutoBadge', { defaultValue: 'auto-allow' })}
          </Badge>
        )}
      </div>

      {/* Auto-allow countdown */}
      {isAuto && !outcome && prompt && (
        <AutoAllowCountdown graceSeconds={prompt.graceSeconds ?? 0} />
      )}

      {/* Structured prompt: tool + input. Falls back to legacy text path
          (`approval-text`) when the server didn't send a structured prompt. */}
      {prompt ? (
        <div className="mt-1 flex flex-col gap-2 text-sm">
          <Row label={t('chat.approvalToolLabel', { defaultValue: 'Tool' })}>
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
              {prompt.toolName}
            </code>
          </Row>
          <Row label={t('chat.approvalInputLabel', { defaultValue: 'Input' })}>
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-surface-2 p-2 font-mono text-xs leading-relaxed text-text">
              {prompt.inputJson}
            </pre>
          </Row>
        </div>
      ) : text ? (
        <pre className="whitespace-pre-wrap break-words text-sm text-text">{text}</pre>
      ) : null}

      {/* Outcome (resolved) or action buttons (pending). */}
      {outcome ? (
        <OutcomeBadge outcome={outcome} />
      ) : prompt ? (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            {/* In auto-allow mode the bus will auto-allow; only Deny is
                meaningful. Hide the Allow/Auto-allow buttons to avoid
                redundant clicks. */}
            {!isAuto && (
              <>
                <Button
                  size="sm"
                  disabled={pendingChoice !== null}
                  onClick={() => handleClick('y')}
                >
                  {t('chat.approvalAllow', { defaultValue: 'Allow' })}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={pendingChoice !== null}
                  onClick={() => handleClick('a')}
                  title={t('chat.approvalAutoTip', {
                    defaultValue: 'Allow and auto-allow similar calls for the rest of the session',
                  })}
                >
                  {t('chat.approvalAuto', { defaultValue: 'Auto for similar' })}
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="destructive"
              disabled={pendingChoice !== null}
              onClick={() => handleClick('n')}
            >
              {t('chat.approvalDeny', { defaultValue: 'Deny' })}
            </Button>
          </div>
          {pendingChoice !== null && (
            <p className="mt-2 text-xs text-text-dim">
              {t('chat.approvalSubmitting')}
            </p>
          )}
        </>
      ) : null}
    </div>
  )
}

interface RowProps {
  label: string
  children: React.ReactNode
}

function Row({ label, children }: RowProps): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-text-muted">{label}</span>
      {children}
    </div>
  )
}

/** Live ticker that counts down from `graceSeconds` to 0. Once the
 *  ticker hits 0 the approval-bus has either already auto-allowed the
 *  call or is about to; the card will be replaced with the outcome via
 *  approval-card-edit. We render "auto-allowing in Ns" until then. */
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
    <p className="mb-2 text-xs text-warning">
      {remaining > 0
        ? t('chat.approvalAutoIn', {
            count: remaining,
            defaultValue: 'Auto-allowing in {{count}}s — Deny to stop.',
          })
        : t('chat.approvalAutoResolving', {
            defaultValue: 'Auto-allowing now…',
          })}
    </p>
  )
}

/** Five terminal states + optional `byUserDisplay` attribution. v1
 *  rendered these with colour + icon prefixes; we do the same via
 *  Badge variant. */
function OutcomeBadge({ outcome }: { outcome: ApprovalCardOutcome }): JSX.Element {
  const { t } = useTranslation()
  const by = outcome.byUserDisplay ? ` · ${outcome.byUserDisplay}` : ''
  switch (outcome.decision) {
    case 'allowed':
      return (
        <div className="mt-3">
          <Badge variant="success">
            {t('chat.outcome.allowed', { defaultValue: '✅ Allowed' })}{by}
          </Badge>
        </div>
      )
    case 'allowed-pinned':
      return (
        <div className="mt-3">
          <Badge variant="success">
            {t('chat.outcome.allowedPinned', {
              defaultValue: '✅ Allowed + auto-allow further',
            })}{by}
          </Badge>
        </div>
      )
    case 'denied':
      return (
        <div className="mt-3">
          <Badge variant="danger">
            {t('chat.outcome.denied', { defaultValue: '❌ Denied' })}{by}
          </Badge>
        </div>
      )
    case 'denied-revoked':
      return (
        <div className="mt-3">
          <Badge variant="danger">
            {t('chat.outcome.deniedRevoked', {
              defaultValue: '❌ Denied (auto-allow revoked)',
            })}{by}
          </Badge>
        </div>
      )
    case 'expired':
      return (
        <div className="mt-3">
          <Badge variant="outline">
            {t('chat.outcome.expired', { defaultValue: '⏱ Timed out' })}{by}
          </Badge>
        </div>
      )
  }
}
