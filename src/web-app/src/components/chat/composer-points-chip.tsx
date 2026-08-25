import { useState } from 'react'
import { Coins } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { ComposerPointsSheet } from '@/components/chat/composer-points-sheet'
import { useComposerPoints } from '@/hooks/use-composer-points'
import { formatPointsCompact } from '@/lib/points-chart'
import { cn } from '@/lib/utils'

export interface ComposerPointsChipProps {
  dark?: boolean
  disabled?: boolean
  chipClassName: string
}

export function ComposerPointsChip({
  dark = false,
  disabled = false,
  chipClassName,
}: ComposerPointsChipProps): JSX.Element | null {
  const { t } = useTranslation()
  const points = useComposerPoints()
  const [open, setOpen] = useState(false)

  if (!points.enabled) return null

  const remaining = points.balance
    ? (points.balance.unlimited
      ? t('chat.statusBar.pointsUnlimitedShort', { defaultValue: 'Unlimited' })
      : formatPointsCompact(points.balance.remaining))
    : (points.loading ? '…' : '—')

  function openSheet(): void {
    if (disabled) return
    setOpen(true)
    void points.refetch()
  }

  return (
    <>
      <button
        type="button"
        className={chipClassName}
        disabled={disabled}
        onClick={openSheet}
        title={t('chat.statusBar.pointsHint', { defaultValue: 'Remaining points and daily spend' })}
        aria-label={t('chat.statusBar.pointsHint', { defaultValue: 'Remaining points and daily spend' })}
      >
        <Coins className={cn('h-3 w-3 shrink-0', dark ? 'text-teal-400' : 'text-teal-600')} />
        <span className="whitespace-nowrap tabular-nums">{remaining}</span>
      </button>
      <ComposerPointsSheet
        open={open}
        onOpenChange={setOpen}
        dark={dark}
        loading={points.loading}
        balance={points.balance}
        daily={points.daily}
        ledger={points.ledger}
      />
    </>
  )
}
