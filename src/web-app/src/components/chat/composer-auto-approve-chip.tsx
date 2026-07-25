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
  // Bus only fires when `effective`. enabled&&!effective = open-IM suppress.
  const suppressed = autoApprove.enabled && !autoApprove.effective
  const active = autoApprove.effective

  async function enableProxyApprove(): Promise<void> {
    const next = await autoApprove.setEnabled(true)
    if (next && !next.effective) {
      toast.warning(t('chat.statusBar.autoApproveSuppressedToast', {
        defaultValue: 'Approve-for-me is on but suppressed (open IM without allowlist). Re-toggle or set AGIM_AUTO_APPROVE_OPEN_IM=1.',
      }))
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled || autoApprove.loading || autoApprove.setting}>
        <button
          type="button"
          className={chipClassName}
          title={suppressed
            ? t('chat.statusBar.autoApproveSuppressedHint', {
              defaultValue: 'Approve-for-me is enabled but not effective — open IM without a strict allowlist. Toggle again to confirm.',
            })
            : t('chat.statusBar.autoApproveHint', {
              defaultValue: 'Main agent tool approvals — auto-approve on your behalf, or ask each time',
            })}
        >
          {active
            ? <ShieldCheck className={cn('h-3 w-3 shrink-0', dark ? 'text-teal-400' : 'text-teal-600')} />
            : <Shield className={cn('h-3 w-3 shrink-0', suppressed ? (dark ? 'text-amber-400' : 'text-amber-600') : 'opacity-60')} />}
          <span className={cn('whitespace-nowrap', suppressed && (dark ? 'text-amber-400' : 'text-amber-600'))}>
            {active
              ? t('chat.statusBar.autoApproveOn', { defaultValue: 'Approve for me' })
              : suppressed
                ? t('chat.statusBar.autoApproveSuppressed', { defaultValue: 'Approve (inactive)' })
                : t('chat.statusBar.autoApproveOff', { defaultValue: 'Ask to approve' })}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[11rem]">
        <DropdownMenuItem
          onSelect={() => {
            void enableProxyApprove().catch((err: unknown) => {
              toast.error(err instanceof Error ? err.message : String(err))
            })
          }}
        >
          <Check className={cn('h-3.5 w-3.5', active ? 'opacity-100' : 'opacity-0')} />
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
