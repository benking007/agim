/**
 * Floating circle that jumps the transcript to the latest message.
 * Shown only while the user has scrolled away from the bottom.
 */

import { ArrowDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

export function ChatJumpToLatest({
  show,
  dark = false,
  onJump,
  className,
}: {
  show: boolean
  dark?: boolean
  onJump: () => void
  className?: string
}): JSX.Element | null {
  const { t } = useTranslation()
  if (!show) return null

  return (
    <button
      type="button"
      onClick={onJump}
      data-testid="chat-jump-to-latest"
      className={cn(
        'flex h-8 w-8 items-center justify-center rounded-full border shadow-md transition-colors',
        dark
          ? 'border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800'
          : 'border-zinc-200 bg-white text-zinc-600 hover:bg-zinc-50',
        className,
      )}
      title={t('chat.portal.jumpToLatest', { defaultValue: 'Scroll to latest' })}
      aria-label={t('chat.portal.jumpToLatest', { defaultValue: 'Scroll to latest' })}
    >
      <ArrowDown className="h-4 w-4" strokeWidth={2.25} />
    </button>
  )
}
