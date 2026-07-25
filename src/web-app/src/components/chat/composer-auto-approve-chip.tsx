import { Check, ChevronDown, Shield, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useComposerAutoApprove } from '@/hooks/use-composer-auto-approve'
import { cn } from '@/lib/utils'

export interface ComposerAutoApproveChipProps {
  dark?: boolean
  disabled?: boolean
  chipClassName: string
}

export function ComposerAutoApproveChip({
  dark = false,
  disabled = false,
  chipClassName,
}: ComposerAutoApproveChipProps): JSX.Element {
  const { t } = useTranslation()
  const autoApprove = useComposerAutoApprove()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled || autoApprove.loading || autoApprove.setting}>
        <button
          type="button"
          className={chipClassName}
          title={t('chat.statusBar.autoApproveHint', {
            defaultValue: 'Main agent tool approvals — auto-approve on your behalf, or ask each time',
          })}
        >
          {autoApprove.enabled
            ? <ShieldCheck className={cn('h-3 w-3 shrink-0', dark ? 'text-teal-400' : 'text-teal-600')} />
            : <Shield className="h-3 w-3 shrink-0 opacity-60" />}
          <span className="whitespace-nowrap">
            {autoApprove.enabled
              ? t('chat.statusBar.autoApproveOn', { defaultValue: 'Approve for me' })
              : t('chat.statusBar.autoApproveOff', { defaultValue: 'Ask to approve' })}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[11rem]">
        <DropdownMenuItem
          onSelect={() => {
            void autoApprove.setEnabled(true).catch((err: unknown) => {
              toast.error(err instanceof Error ? err.message : String(err))
            })
          }}
        >
          <Check className={cn('h-3.5 w-3.5', autoApprove.enabled ? 'opacity-100' : 'opacity-0')} />
          <span>{t('chat.statusBar.autoApproveOn', { defaultValue: 'Approve for me' })}</span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => {
            void autoApprove.setEnabled(false).catch((err: unknown) => {
              toast.error(err instanceof Error ? err.message : String(err))
            })
          }}
        >
          <Check className={cn('h-3.5 w-3.5', !autoApprove.enabled ? 'opacity-100' : 'opacity-0')} />
          <span>{t('chat.statusBar.autoApproveOff', { defaultValue: 'Ask to approve' })}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
