import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

interface PortalEmptyChatProps {
  dark: boolean
  loading?: boolean
}

export function PortalEmptyChat({
  dark,
  loading = false,
}: PortalEmptyChatProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        loading ? 'min-h-[calc(100dvh-14rem)] gap-3' : 'sr-only',
      )}
      data-testid="portal-empty-chat"
    >
      {loading ? (
        <>
          <Loader2
            className={cn('h-8 w-8 animate-spin', dark ? 'text-zinc-400' : 'text-zinc-500')}
            aria-hidden
          />
          <p
            className={cn('text-sm', dark ? 'text-zinc-400' : 'text-zinc-500')}
            data-testid="portal-session-loading"
            role="status"
          >
            {t('chat.portal.loadingSession', { defaultValue: '正在加载会话…' })}
          </p>
        </>
      ) : null}
    </div>
  )
}
