/**
 * Nested accordion row: show the full prompt-injection snapshot for a turn.
 * Long dumps (system + ephemeral) scroll inside a capped container.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, FileText } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface InjectedContextDetailsProps {
  text: string
  dark?: boolean
  className?: string
}

export function InjectedContextDetails({
  text,
  dark = false,
  className,
}: InjectedContextDetailsProps): JSX.Element | null {
  const { t, i18n } = useTranslation()
  const zh = Boolean(i18n.language?.startsWith('zh'))
  const [open, setOpen] = useState(false)
  const trimmed = text.trim()
  if (!trimmed) return null

  const chars = trimmed.length
  const sizeLabel = chars >= 1000
    ? `${(chars / 1000).toFixed(chars >= 10_000 ? 0 : 1)}k`
    : String(chars)

  return (
    <div className={cn('min-w-0', className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'flex w-full max-w-full items-center gap-1.5 rounded-md py-0.5 text-left text-[12px] transition',
          dark ? 'text-zinc-300 hover:bg-zinc-900' : 'text-zinc-700 hover:bg-zinc-100',
        )}
      >
        <FileText className="h-3 w-3 shrink-0 opacity-70" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {t('chat.activityInjectedContext', {
            defaultValue: zh ? '注入内容' : 'Injected context',
          })}
        </span>
        <span className={cn(
          'shrink-0 text-[9px] uppercase tracking-wide',
          dark ? 'text-zinc-500' : 'text-zinc-400',
        )}>
          {t('chat.activityInjectedChars', {
            count: chars,
            size: sizeLabel,
            defaultValue: zh ? `${sizeLabel} 字` : `${sizeLabel} chars`,
          })}
        </span>
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 opacity-60 transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
      </button>
      {open && (
        <pre
          data-testid="injected-context-body"
          className={cn(
            'agim-mono mt-1 max-h-[min(40vh,20rem)] overflow-auto whitespace-pre-wrap break-words rounded-md px-2.5 py-2 text-[11px] leading-relaxed',
            dark ? 'bg-zinc-900 text-zinc-400' : 'bg-zinc-100 text-zinc-600',
          )}
        >
          {trimmed}
        </pre>
      )}
    </div>
  )
}
