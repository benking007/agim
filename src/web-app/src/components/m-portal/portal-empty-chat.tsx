import type { LucideIcon } from 'lucide-react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { displayAgentName } from './agent-visuals'

interface PortalEmptyChatProps {
  dark: boolean
  agentId: string
  visual: { color: string }
  AgentIcon: LucideIcon
  loading?: boolean
}

export function PortalEmptyChat({
  dark,
  agentId,
  visual,
  AgentIcon,
  loading = false,
}: PortalEmptyChatProps): JSX.Element {
  const { t } = useTranslation()

  return (
    <div
      className="flex animate-in fade-in flex-col items-center space-y-4 py-16 text-center duration-500"
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
      ) : (
        <>
          <div className={cn(
            'flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-tr text-white shadow-md ring-4',
            dark ? 'ring-white/5' : 'ring-black/5',
            visual.color,
          )}>
            <AgentIcon className="h-6 w-6" />
          </div>
          <p className={cn('text-base font-semibold tracking-tight', dark ? 'text-zinc-100' : 'text-zinc-800')}>
            {displayAgentName(agentId)}
          </p>
        </>
      )}
    </div>
  )
}
