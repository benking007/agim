/**
 * MessageActions — good / bad / copy affordances under an assistant reply.
 */

import { useState } from 'react'
import { Check, Copy, ThumbsDown, ThumbsUp } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export interface MessageActionsProps {
  content: string
  dark?: boolean
  className?: string
}

export function MessageActions({ content, dark, className }: MessageActionsProps): JSX.Element | null {
  const [copied, setCopied] = useState(false)
  const [vote, setVote] = useState<'up' | 'down' | null>(null)

  if (!content.trim()) return null

  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('复制失败')
    }
  }

  function onVote(next: 'up' | 'down'): void {
    setVote(next)
    toast.success(next === 'up' ? '已标记为有帮助' : '已标记为需改进')
  }

  const btn = cn(
    'inline-flex h-7 w-7 items-center justify-center rounded-lg transition',
    dark ? 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700',
  )

  return (
    <div className={cn('flex items-center justify-end gap-0.5 pt-1', className)}>
      <button
        type="button"
        className={cn(btn, vote === 'up' && (dark ? 'text-emerald-400' : 'text-emerald-600'))}
        aria-label="Good"
        title="有帮助"
        onClick={() => onVote('up')}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={cn(btn, vote === 'down' && (dark ? 'text-red-400' : 'text-red-500'))}
        aria-label="Bad"
        title="需改进"
        onClick={() => onVote('down')}
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        className={btn}
        aria-label="Copy"
        title="复制回复"
        onClick={() => void onCopy()}
      >
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  )
}
