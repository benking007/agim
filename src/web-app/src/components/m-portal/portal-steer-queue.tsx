/**
 * Pending-send card above the composer.
 * One rounded tray; each row can Steer (mid-turn), delete, or re-edit.
 */

import { CornerDownLeft, FileText, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  onReedit,
}: {
  dark: boolean
  items: PendingSendItem[]
  onSend: (id: string) => void
  onDismiss: (id: string) => void
  onReedit: (id: string) => void
}): JSX.Element | null {
  const { t } = useTranslation()
  if (items.length === 0) return null

  return (
    <ul
      className={cn(
        'mb-1.5 list-none overflow-hidden rounded-2xl border p-0 shadow-sm',
        dark ? 'border-zinc-800 bg-zinc-900/95 text-zinc-200' : 'border-zinc-200 bg-white text-zinc-800',
      )}
      data-testid="portal-steer-queue"
      aria-label={t('chat.portal.steerQueue', { defaultValue: 'Pending messages' })}
    >
      {items.map((item, index) => (
        <li
          key={item.id}
          className={cn(
            'flex items-center gap-2 px-3 py-2 text-[13px] leading-5',
            index > 0 && (dark ? 'border-t border-zinc-800' : 'border-t border-zinc-100'),
          )}
        >
          <FileText
            className={cn('h-3.5 w-3.5 shrink-0', dark ? 'text-zinc-500' : 'text-zinc-400')}
            aria-hidden
          />
          <p className="min-w-0 flex-1 truncate" title={item.text}>
            {item.flushAfter
              ? `${t('chat.portal.steerQueueAfterTurn', { defaultValue: 'Will send after this turn' })} · `
              : null}
            {item.text}
          </p>
          <div className="flex shrink-0 items-center gap-0.5">
            {!item.flushAfter ? (
              <button
                type="button"
                onClick={() => onSend(item.id)}
                className={cn(
                  'flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] font-medium transition-colors',
                  dark
                    ? 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
                    : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800',
                )}
                data-testid="steer-queue-send"
                title={t('chat.portal.steerQueueSendHint', { defaultValue: 'Interrupt this turn and send' })}
                aria-label={t('chat.portal.steerQueueSendHint', { defaultValue: 'Interrupt this turn and send' })}
              >
                <span>{t('chat.portal.steerQueueSend', { defaultValue: 'Steer' })}</span>
                <CornerDownLeft className="h-3 w-3" />
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => onDismiss(item.id)}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                dark
                  ? 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
                  : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700',
              )}
              data-testid="steer-queue-dismiss"
              title={t('chat.portal.steerQueueDismiss', { defaultValue: 'Delete' })}
              aria-label={t('chat.portal.steerQueueDismiss', { defaultValue: 'Delete' })}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                    dark
                      ? 'text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200'
                      : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700',
                  )}
                  data-testid="steer-queue-more"
                  title={t('chat.portal.steerQueueMore', { defaultValue: 'More' })}
                  aria-label={t('chat.portal.steerQueueMore', { defaultValue: 'More' })}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className={dark ? 'border-zinc-800 bg-zinc-900 text-zinc-100' : undefined}
              >
                <DropdownMenuItem
                  onSelect={() => onReedit(item.id)}
                  className={dark ? 'focus:bg-zinc-800' : undefined}
                >
                  <Pencil className="h-3.5 w-3.5" />
                  {t('chat.portal.steerQueueEdit', { defaultValue: 'Re-edit' })}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </li>
      ))}
    </ul>
  )
}
