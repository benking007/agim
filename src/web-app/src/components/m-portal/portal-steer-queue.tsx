/**
 * Visual pending-send slots above the Portal composer.
 * Items sit here while the agent is working; Send injects (Agim) or
 * waits until the turn ends (other agents).
 */

import { Send, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { cn } from '@/lib/utils'

export interface PendingSendItem {
  id: string
  text: string
  /** Armed to flush as a normal message after the current turn. */
  flushAfter?: boolean
}

export function PortalSteerQueue({
  dark,
  items,
  onSend,
  onDismiss,
}: {
  dark: boolean
  items: PendingSendItem[]
  onSend: (id: string) => void
  onDismiss: (id: string) => void
}): JSX.Element | null {
  const { t } = useTranslation()
  if (items.length === 0) return null

  return (
    <ul
      className="mb-1.5 list-none space-y-1 p-0"
      data-testid="portal-steer-queue"
      aria-label={t('chat.portal.steerQueue', { defaultValue: 'Pending messages' })}
    >
      {items.map((item) => (
        <li
          key={item.id}
          className={cn(
            'flex items-center gap-1.5 rounded-2xl border px-2.5 py-1.5 text-[13px] leading-5',
            dark ? 'border-zinc-800 bg-zinc-900/90 text-zinc-200' : 'border-zinc-200 bg-white text-zinc-800',
          )}
        >
          <p className="min-w-0 flex-1 truncate" title={item.text}>
            {item.flushAfter
              ? `${t('chat.portal.steerQueueAfterTurn', { defaultValue: 'Will send after this turn' })} · `
              : null}
            {item.text}
          </p>
          {!item.flushAfter ? (
            <button
              type="button"
              onClick={() => onSend(item.id)}
              className={cn(
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors',
                dark ? 'text-teal-300 hover:bg-zinc-800' : 'text-teal-700 hover:bg-zinc-100',
              )}
              title={t('chat.portal.steerQueueSend', { defaultValue: 'Send now' })}
              aria-label={t('chat.portal.steerQueueSend', { defaultValue: 'Send now' })}
            >
              <Send className="h-3 w-3" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onDismiss(item.id)}
            className={cn(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors',
              dark ? 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700',
            )}
            title={t('chat.portal.steerQueueDismiss', { defaultValue: 'Remove' })}
            aria-label={t('chat.portal.steerQueueDismiss', { defaultValue: 'Remove' })}
          >
            <X className="h-3 w-3" />
          </button>
        </li>
      ))}
    </ul>
  )
}
