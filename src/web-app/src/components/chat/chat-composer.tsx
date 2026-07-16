/**
 * ChatComposer — shared iMessage-style input chrome for `/` and `/m/chat`.
 *
 * - Pill textarea with auto-grow (capped)
 * - 44×44 send button (Apple HIG minimum)
 * - IME-safe Enter handling (desktop: Enter sends; mobile: newline)
 * - Optional leading action (e.g. new conversation)
 * - Optional footer slot (streaming badge, activity link, …)
 */

import { useEffect, useRef, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Send } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface ChatComposerProps {
  value: string
  onChange: (next: string) => void
  onSubmit: () => void
  disabled?: boolean
  /** Show spinner on the send button when empty (streaming); does not block send. */
  busy?: boolean
  /** When true, Enter inserts a newline; Send button submits. */
  enterNewline?: boolean
  placeholder?: string
  leading?: ReactNode
  /** Content above the input row (quick prompts, run banner, …). */
  prepend?: ReactNode
  footer?: ReactNode
  /** Extra class on the outer sticky form. */
  className?: string
  /** Lift the form above the soft keyboard (visualViewport inset). */
  keyboardInset?: number
  /** Safe-area bottom padding (default true). */
  safeArea?: boolean
  inputRef?: RefObject<HTMLTextAreaElement | null>
  /** Max lines before scroll (default 6). */
  maxLines?: number
}

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  busy = false,
  enterNewline = false,
  placeholder,
  leading,
  prepend,
  footer,
  className,
  keyboardInset = 0,
  safeArea = true,
  inputRef: externalRef,
  maxLines = 6,
}: ChatComposerProps): JSX.Element {
  const { t } = useTranslation()
  const localRef = useRef<HTMLTextAreaElement>(null)
  const inputRef = externalRef ?? localRef

  useEffect(() => {
    const ta = inputRef.current
    if (!ta) return
    ta.style.height = 'auto'
    const line = 24
    const pad = 16
    // `value` is read so height tracks typed content (auto-grow).
    const scroll = value.length >= 0 ? ta.scrollHeight : 0
    ta.style.height = `${Math.min(scroll, line * maxLines + pad)}px`
  }, [value, maxLines, inputRef])

  function handleSubmit(e?: FormEvent): void {
    e?.preventDefault()
    // Busy blocks a second send while streaming so WS chunks stay bound
    // to the current reply (runId / currentReplyId stay aligned).
    if (disabled || busy || !value.trim()) return
    onSubmit()
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    const ne = e.nativeEvent as { isComposing?: boolean }
    if (ne.isComposing || e.keyCode === 229) return
    if (enterNewline) return
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const canSend = !!value.trim() && !disabled && !busy

  return (
    <form
      onSubmit={handleSubmit}
      className={cn(
        'sticky bottom-0 z-10 border-t border-border bg-surface/95 backdrop-blur-md',
        'px-3 pt-2 sm:px-4',
        className,
      )}
      style={{
        paddingBottom: safeArea
          ? `calc(env(safe-area-inset-bottom) + 0.5rem + ${keyboardInset}px)`
          : `calc(0.5rem + ${keyboardInset}px)`,
      }}
    >
      {prepend ? (
        <div className="mx-auto mb-2 max-w-3xl">{prepend}</div>
      ) : null}
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        {leading}
        <textarea
          ref={inputRef as RefObject<HTMLTextAreaElement>}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? t('chat.inputPlaceholder', {
            defaultValue: 'Message… (Enter sends, Shift+Enter newlines)',
          })}
          rows={1}
          enterKeyHint={enterNewline ? 'enter' : 'send'}
          className={cn(
            'flex-1 resize-none rounded-[22px] border border-border bg-bg',
            // text-md = 16px (theme `text-base` is 15px). iOS Safari auto-zooms
            // focused inputs under 16px and often leaves the page stuck zoomed.
            'px-4 py-2.5 text-md leading-6',
            'focus:outline-none focus:ring-2 focus:ring-accent/40 focus:ring-offset-1 focus:ring-offset-bg',
            'placeholder:text-text-muted',
          )}
        />
        <Button
          type="submit"
          disabled={!canSend}
          aria-label={t('chat.send', { defaultValue: 'Send' })}
          className="h-11 w-11 shrink-0 rounded-full p-0"
        >
          {busy && !canSend ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <Send className="h-5 w-5" />
          )}
        </Button>
      </div>
      {footer ? (
        <div className="mx-auto mt-2 max-w-3xl">{footer}</div>
      ) : null}
    </form>
  )
}
