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
  if (asks.length === 0) return null
  return (
    <div className="border-t border-info/40 bg-info-bg/40">
      <div className="mx-auto max-h-72 w-full max-w-3xl overflow-y-auto px-3 py-2 sm:px-4">
        <div className="flex flex-col gap-2">
          {asks.map((a) => (
            <AskRow key={a.messageId} entry={a} onSubmit={onSubmit} />
          ))}
        </div>
      </div>
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
}

function AskRow({ entry, onSubmit }: AskRowProps): JSX.Element {
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
    <div
      className={cn(
        'rounded-lg border bg-surface p-3 shadow-sm transition-opacity',
        resolved ? 'border-success/60 opacity-80' : 'border-info',
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <Badge variant="info" className="gap-1">
          <ListChecks className="h-3 w-3" />
          {prompt.title || t('chat.askTitle', { defaultValue: '🤔 请选择' })}
        </Badge>
        {!resolved && selectionMode === 'multi' && (
          <span className="text-xs text-text-dim">
            {t('chat.askMultiHint', {
              min: minSel,
              max: maxSel,
              defaultValue: 'Pick {{min}}–{{max}}',
            })}
          </span>
        )}
      </div>

      <p className="mb-2 whitespace-pre-wrap break-words text-sm text-text">{prompt.body}</p>

      {resolved ? (
        <Badge variant="success">{finalText || t('chat.askResolved', { defaultValue: '✅ 已回答' })}</Badge>
      ) : selectionMode === 'multi' ? (
        <>
          <div className="flex flex-col gap-1.5">
            {prompt.choices.map((c) => {
              const idx = choiceIndex(c.data)
              const on = picked.includes(idx)
              return (
                <label
                  key={c.data}
                  className={cn(
                    'flex cursor-pointer items-center gap-2 rounded border px-2 py-1.5 text-sm transition',
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
          <div className="mt-2">
            <Button
              size="sm"
              className="min-h-11 px-3"
              disabled={submitting || !multiReady}
              onClick={() => submit(`ask:${reqId}:multi:${[...picked].sort((a, b) => a - b).join(',')}`)}
            >
              {t('chat.askSubmit', { defaultValue: 'Submit' })}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          {prompt.choices.map((c) => (
            <Button
              key={c.data}
              size="sm"
              variant="secondary"
              className="min-h-11 px-3"
              disabled={submitting}
              onClick={() => submit(c.data)}
            >
              {c.label}
            </Button>
          ))}
        </div>
      )}

      {!resolved && allowCustom && (
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={custom}
            disabled={submitting}
            placeholder={meta?.customInputLabel || t('chat.askCustomPlaceholder', { defaultValue: '自定义回答…' })}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && custom.trim()) submit(`ask:${reqId}:custom:${base64url(custom.trim())}`)
            }}
            className="flex-1 rounded border border-border bg-surface px-2 py-2 text-base text-text outline-none focus:border-info"
          />
          <Button
            size="sm"
            variant="outline"
            className="min-h-11 px-3"
            disabled={submitting || !custom.trim()}
            onClick={() => submit(`ask:${reqId}:custom:${base64url(custom.trim())}`)}
          >
            {t('chat.askSubmit', { defaultValue: 'Submit' })}
          </Button>
        </div>
      )}

      {prompt.links?.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {prompt.links.map((l) => (
            <a
              key={l.url}
              href={l.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded border border-border px-2 py-1 text-xs text-info underline-offset-2 transition hover:bg-surface-2 hover:underline"
            >
              {l.label}
            </a>
          ))}
        </div>
      ) : null}

      {submitting && !resolved && (
        <p className="mt-1.5 text-xs text-text-dim">{t('chat.approvalSubmitting')}</p>
      )}
    </div>
  )
}
