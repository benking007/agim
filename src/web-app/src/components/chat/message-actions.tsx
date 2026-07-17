/**
 * MessageActions — good / bad / copy affordances under an assistant reply.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, ThumbsDown, ThumbsUp } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export interface MessageActionsProps {
  content: string
  dark?: boolean
  className?: string
}

export function MessageActions({ content, dark, className }: MessageActionsProps): JSX.Element | null {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [vote, setVote] = useState<'up' | 'down' | null>(null)

  if (!content.trim()) return null

  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error(t('chat.copyFailed'))
    }
  }

  function onVote(next: 'up' | 'down'): void {
    setVote(next)
    toast.success(next === 'up' ? t('chat.portal.feedbackGood') : t('chat.portal.feedbackBad'))
  }

  const btn = cn(
    'inline-flex h-5 w-5 items-center justify-center rounded-md transition',
    dark ? 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700',
  )

  return (
    <div className={cn('flex items-center justify-start gap-0 pt-1.5', className)}>
      <button
        type="button"
        className={cn(btn, vote === 'up' && (dark ? 'text-emerald-400' : 'text-emerald-600'))}
        aria-label="Good"
        title={t('chat.portal.feedbackGood')}
        onClick={() => onVote('up')}
      >
        <ThumbsUp className="h-3 w-3" />
      </button>
      <button
        type="button"
        className={cn(btn, vote === 'down' && (dark ? 'text-red-400' : 'text-red-500'))}
        aria-label="Bad"
        title={t('chat.portal.feedbackBad')}
        onClick={() => onVote('down')}
      >
        <ThumbsDown className="h-3 w-3" />
      </button>
      <button
        type="button"
        className={btn}
        aria-label="Copy"
        title={t('chat.copy')}
        onClick={() => void onCopy()}
      >
        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  )
}
