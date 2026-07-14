/**
 * AskDock — floating panel for pending ask_user (choice) cards.
 *
 * The visual sibling of ApprovalDock: it renders the agent's structured
 * questions (mcp__agim__ask_user) right above the chat input so the user
 * can answer by clicking instead of typing "1". Three modes, driven by
 * `prompt.meta`:
 *   - single  → one button per choice; click submits immediately.
 *   - multi   → checkbox list; submit enabled only when the selection count
 *               is within [minSelections, maxSelections].
 *   - custom  → an extra free-text input (when meta.allowCustomInput).
 *
 * Each answer is encoded into the `ask:<reqId>:…` callback string that
 * ask-user-router parses (single uses the choice's prebuilt `data`; multi
 * and custom are assembled here next to the selection state). On resolve
 * (answer accepted, or the ask timed out) the row flips to a receipt for a
 * beat, then use-chat.ts dismisses it.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ListChecks } from 'lucide-react'

import type { PendingAsk } from '@/hooks/use-chat'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface AskDockProps {
  asks: PendingAsk[]
  /** Submit a fully-formed `ask:<reqId>:…` callback. Returns whether the
   *  WS send went out, so the row can revert its optimistic state. */
  onSubmit: (messageId: string, data: string) => boolean | undefined
}

export function AskDock({ asks, onSubmit }: AskDockProps): JSX.Element | null {
  const { t } = useTranslation()
  if (asks.length === 0) return null
  return (
    <div className="relative z-20 px-3 pb-1.5 pt-0 sm:px-4">
      <section
        className={cn(
          'mx-auto flex w-full max-w-3xl flex-col',
          'max-h-[min(52vh,28rem)]',
          'rounded-2xl border border-info/30 bg-surface/98',
          'shadow-[0_-8px_30px_rgba(15,23,42,0.12)]',
          'ring-1 ring-black/5',
          'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-200',
        )}
        aria-label={t('chat.askTitle', { defaultValue: 'Choose an option' })}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-info/15 bg-info-bg/90 px-4 py-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-info/15 text-info">
            <ListChecks className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold tracking-tight text-text">
              {t('chat.askTitle', { defaultValue: 'Choose an option' })}
            </p>
            <p className="truncate text-xs text-text-dim">
              {asks.length > 1
                ? t('chat.askPendingCount', {
                    count: asks.length,
                    defaultValue: '{{count}} questions waiting',
                  })
                : t('chat.askSubtitle', {
                    defaultValue: 'The agent needs your answer to continue',
                  })}
            </p>
          </div>
          {asks.length > 1 && (
            <Badge variant="info" className="shrink-0 tabular-nums">
              {asks.length}
            </Badge>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="flex flex-col divide-y divide-border/70">
            {asks.map((a) => (
              <AskRow key={a.messageId} entry={a} onSubmit={onSubmit} stacked={asks.length > 1} />
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

/** btoa over UTF-8 bytes, then base64url (matches ask-user-rpc's
 *  decodeBase64Url: `-`/`_` and no padding). btoa alone mangles non-Latin1
 *  text, so we widen to bytes first. */
function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** The 1-based index a choice carries in its prebuilt single-select data
 *  (`ask:<reqId>:<index>`). Parsing it keeps multi-select aligned with the
 *  server's numbering even if labels were reordered. */
function choiceIndex(data: string): number {
  const tail = data.split(':').pop() ?? ''
  return Number.parseInt(tail, 10)
}

interface AskRowProps {
  entry: PendingAsk
  onSubmit: (messageId: string, data: string) => boolean | undefined
  stacked?: boolean
}

function AskRow({ entry, onSubmit, stacked = false }: AskRowProps): JSX.Element {
  const { t } = useTranslation()
  const { messageId, prompt, finalText, resolvedAt } = entry
  const meta = prompt.meta
  const resolved = finalText != null || resolvedAt != null

  // Optimistic "submitting" lock — mirrors the approval dock so a click
  // disables the controls until the server's choice-card-edit lands.
  const [submitting, setSubmitting] = useState(false)
  // Multi-select working set (1-based indexes) and the custom-input draft.
  const [picked, setPicked] = useState<number[]>([])
  const [custom, setCustom] = useState('')
  useEffect(() => { if (resolved) setSubmitting(false) }, [resolved])

  const selectionMode = meta?.selectionMode ?? 'single'
  const minSel = meta?.minSelections ?? 1
  const maxSel = meta?.maxSelections ?? prompt.choices.length
  const allowCustom = meta?.allowCustomInput ?? false
  const reqId = meta?.reqId ?? ''
  const title = prompt.title || t('chat.askTitle', { defaultValue: 'Choose an option' })

  function submit(data: string): void {
    if (submitting) return
    setSubmitting(true)
    const ok = onSubmit(messageId, data)
    if (ok === false) setSubmitting(false)
  }

  function toggle(idx: number): void {
    setPicked((cur) => (cur.includes(idx) ? cur.filter((n) => n !== idx) : [...cur, idx]))
  }

  const multiReady = picked.length >= minSel && picked.length <= maxSel

  return (
    <div className={cn('px-4 py-4 transition-opacity', resolved && 'opacity-80')}>
      <div className="mb-3">
        {stacked && (
          <div className="mb-1.5 text-xs text-text-dim">{title}</div>
        )}
        {!stacked && prompt.title ? (
          <p className="mb-1 text-sm font-semibold text-text">{prompt.title}</p>
        ) : null}
        {!resolved && selectionMode === 'multi' && (
          <p className="mb-2 text-xs text-text-dim">
            {t('chat.askMultiHint', {
              min: minSel,
              max: maxSel,
              defaultValue: 'Pick {{min}}–{{max}}',
            })}
          </p>
        )}
        <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed text-text">
          {prompt.body}
        </p>
      </div>

      {resolved ? (
        <Badge variant="success">{finalText || t('chat.askResolved', { defaultValue: 'Answered' })}</Badge>
      ) : selectionMode === 'multi' ? (
        <>
          <div className="flex flex-col gap-2">
            {prompt.choices.map((c) => {
              const idx = choiceIndex(c.data)
              const on = picked.includes(idx)
              return (
                <label
                  key={c.data}
                  className={cn(
                    'flex min-h-11 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-sm transition',
                    on ? 'border-info bg-info-bg/50' : 'border-border hover:bg-surface-2',
                    submitting && 'pointer-events-none opacity-60',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={submitting}
                    onChange={() => toggle(idx)}
                  />
                  <span>{c.label}</span>
                </label>
              )
            })}
          </div>
          <div className="mt-3">
            <Button
              className="min-h-12 w-full text-sm font-semibold"
              disabled={submitting || !multiReady}
              onClick={() => submit(`ask:${reqId}:multi:${[...picked].sort((a, b) => a - b).join(',')}`)}
            >
              {t('chat.askSubmit', { defaultValue: 'Submit' })}
            </Button>
          </div>
        </>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {prompt.choices.map((c) => (
            <Button
              key={c.data}
              variant="secondary"
              className="min-h-12 w-full justify-start px-4 text-left text-sm"
              disabled={submitting}
              onClick={() => submit(c.data)}
            >
              {c.label}
            </Button>
          ))}
        </div>
      )}

      {!resolved && allowCustom && (
        <div className="mt-3 flex gap-2">
          <input
            type="text"
            value={custom}
            disabled={submitting}
            placeholder={meta?.customInputLabel || t('chat.askCustomPlaceholder', { defaultValue: '自定义回答…' })}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && custom.trim()) submit(`ask:${reqId}:custom:${base64url(custom.trim())}`)
            }}
            className="flex-1 rounded-xl border border-border bg-bg px-3 py-2.5 text-base text-text outline-none focus:border-info focus:ring-2 focus:ring-info/20"
          />
          <Button
            variant="outline"
            className="min-h-12 px-4"
            disabled={submitting || !custom.trim()}
            onClick={() => submit(`ask:${reqId}:custom:${base64url(custom.trim())}`)}
          >
            {t('chat.askSubmit', { defaultValue: 'Submit' })}
          </Button>
        </div>
      )}

      {prompt.links?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {prompt.links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center rounded-xl border border-border px-3 py-2 text-sm text-info underline-offset-2 transition hover:bg-surface-2 hover:underline"
            >
              {l.label}
            </a>
          ))}
        </div>
      ) : null}

      {submitting && !resolved && (
        <p className="mt-2 text-xs text-text-dim">{t('chat.approvalSubmitting')}</p>
      )}
    </div>
  )
}
