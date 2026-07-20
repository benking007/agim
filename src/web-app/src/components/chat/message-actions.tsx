/**
 * MessageActions — good / bad / copy + platform export under an assistant reply.
 *
 * Browser: Save as Markdown (Web Share is weak / clipboard-only → hide Share).
 * iOS / macOS shells: Share via OS sheet (Save opens/preview awkwardly → hide Save).
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Copy, FileDown, Share2, ThumbsDown, ThumbsUp } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { isAgimNativeShell } from '@/lib/agim-shell'
import { markdownFilenameFromContent, saveTextAsFile } from '@/lib/save-text-file'
import { shareContent } from '@/lib/share-content'

export interface MessageActionsProps {
  content: string
  dark?: boolean
  className?: string
}

export function MessageActions({ content, dark, className }: MessageActionsProps): JSX.Element | null {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [vote, setVote] = useState<'up' | 'down' | null>(null)
  const nativeShell = isAgimNativeShell()

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

  async function onSaveMarkdown(): Promise<void> {
    if (saving) return
    setSaving(true)
    try {
      const result = await saveTextAsFile({
        filename: markdownFilenameFromContent(content),
        content,
        mime: 'text/markdown;charset=utf-8',
      })
      if (result === 'cancelled') return
      if (result === 'download') {
        toast.success(t('chat.saveMarkdownStarted'))
      }
    } catch {
      toast.error(t('chat.saveMarkdownFailed'))
    } finally {
      setSaving(false)
    }
  }

  async function onShare(): Promise<void> {
    if (sharing) return
    setSharing(true)
    try {
      const result = await shareContent({
        title: 'Agim',
        text: content,
        filename: markdownFilenameFromContent(content),
      })
      if (result === 'cancelled') return
      if (result === 'copied') {
        toast.success(t('chat.shareCopied'))
      }
      // native: the OS sheet is enough feedback.
    } catch {
      toast.error(t('chat.shareFailed'))
    } finally {
      setSharing(false)
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
        aria-label={t('chat.portal.feedbackGood')}
        title={t('chat.portal.feedbackGood')}
        onClick={() => onVote('up')}
      >
        <ThumbsUp className="h-3 w-3" />
      </button>
      <button
        type="button"
        className={cn(btn, vote === 'down' && (dark ? 'text-red-400' : 'text-red-500'))}
        aria-label={t('chat.portal.feedbackBad')}
        title={t('chat.portal.feedbackBad')}
        onClick={() => onVote('down')}
      >
        <ThumbsDown className="h-3 w-3" />
      </button>
      <button
        type="button"
        className={btn}
        aria-label={t('chat.copy')}
        title={t('chat.copy')}
        onClick={() => void onCopy()}
      >
        {copied ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
      </button>
      {!nativeShell && (
        <button
          type="button"
          className={btn}
          aria-label={t('chat.saveMarkdown')}
          title={t('chat.saveMarkdown')}
          disabled={saving}
          onClick={() => void onSaveMarkdown()}
        >
          <FileDown className={cn('h-3 w-3', saving && 'opacity-50')} />
        </button>
      )}
      {nativeShell && (
        <button
          type="button"
          className={btn}
          aria-label={t('chat.share')}
          title={t('chat.share')}
          disabled={sharing}
          onClick={() => void onShare()}
        >
          <Share2 className={cn('h-3 w-3', sharing && 'opacity-50')} />
        </button>
      )}
    </div>
  )
}
