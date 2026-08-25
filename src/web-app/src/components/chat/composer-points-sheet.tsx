/**
 * Composer-docked points sheet — remaining quota, recent spend, daily curve.
 * Portals into `[data-agim-composer-sheet-root]` like Subagent details.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Coins, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  formatPointsCompact,
  monthDayLabel,
  sparklineLayout,
} from '@/lib/points-chart'
import type { DailyPointsSpend, PointsBalance, PointsLedgerRow } from '@/types/api'

export interface ComposerPointsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  dark?: boolean
  loading?: boolean
  balance: PointsBalance | null
  daily: DailyPointsSpend[]
  ledger: PointsLedgerRow[]
}

function formatDayTime(at: number, locale: string): string {
  try {
    return new Date(at).toLocaleString(locale, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return new Date(at).toISOString()
  }
}

function reasonLabel(
  t: (key: string, opts?: { defaultValue?: string }) => string,
  reason: string,
): string {
  if (reason === 'agim_turn') {
    return t('chat.statusBar.pointsReasonTurn', { defaultValue: 'Agent turn' })
  }
  if (reason === 'admin_grant') {
    return t('chat.statusBar.pointsReasonGrant', { defaultValue: 'Admin grant' })
  }
  return reason
}

function DailySpendChart({
  daily,
  dark,
  label,
  emptyLabel,
}: {
  daily: DailyPointsSpend[]
  dark: boolean
  label: string
  emptyLabel: string
}): JSX.Element {
  const values = daily.map((d) => d.spent)
  const layout = sparklineLayout(values, 280, 88)
  const total = values.reduce((sum, n) => sum + n, 0)
  if (daily.length === 0 || total === 0) {
    return (
      <div
        className={cn(
          'flex h-[88px] items-center justify-center rounded-xl text-xs',
          dark ? 'bg-zinc-900 text-zinc-500' : 'bg-zinc-50 text-text-muted',
        )}
      >
        {emptyLabel}
      </div>
    )
  }
  const first = daily[0]
  const last = daily[daily.length - 1]
  const mid = daily[Math.floor(daily.length / 2)]
  if (!first || !last || !mid) {
    return (
      <div
        className={cn(
          'flex h-[88px] items-center justify-center rounded-xl text-xs',
          dark ? 'bg-zinc-900 text-zinc-500' : 'bg-zinc-50 text-text-muted',
        )}
      >
        {emptyLabel}
      </div>
    )
  }
  const stroke = dark ? '#2dd4bf' : '#0d9488'
  const fill = dark ? 'rgba(45,212,191,0.18)' : 'rgba(13,148,136,0.16)'
  return (
    <div>
      <svg
        viewBox="0 0 280 88"
        className="h-[88px] w-full"
        role="img"
        aria-label={label}
      >
        <path d={layout.area} fill={fill} />
        <path d={layout.line} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <div className={cn(
        'mt-1 flex justify-between text-[10px]',
        dark ? 'text-zinc-500' : 'text-text-muted',
      )}
      >
        <span>{monthDayLabel(first.day)}</span>
        <span>{monthDayLabel(mid.day)}</span>
        <span>{monthDayLabel(last.day)}</span>
      </div>
    </div>
  )
}

export function ComposerPointsSheet({
  open,
  onOpenChange,
  dark = false,
  loading = false,
  balance,
  daily,
  ledger,
}: ComposerPointsSheetProps): JSX.Element {
  const { t, i18n } = useTranslation()
  const [sheetRoot, setSheetRoot] = useState<HTMLElement | null>(null)
  const portalColumn = sheetRoot?.getAttribute('data-agim-sheet-column') === 'portal'
  const docked = !!sheetRoot
  const locale = i18n.language?.startsWith('zh') ? 'zh-CN' : 'en'

  useEffect(() => {
    if (!open) return
    setSheetRoot(document.querySelector<HTMLElement>('[data-agim-composer-sheet-root]'))
  }, [open])

  const cap = balance ? balance.monthlyLimit + balance.bonus : 0
  const used = balance?.usedThisPeriod ?? 0
  const ratio = cap > 0 ? Math.min(1, used / cap) : 0
  const recent = ledger.slice(0, 8)

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal container={sheetRoot ?? undefined}>
        <DialogPrimitive.Overlay
          className={cn(
            docked ? 'absolute inset-0' : 'fixed inset-0',
            'z-50 bg-black/30 backdrop-blur-[2px]',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          )}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className={cn(
            docked ? 'absolute' : 'fixed',
            'left-1/2 z-50 -translate-x-1/2',
            'bottom-[calc(5.75rem+env(safe-area-inset-bottom,0px))]',
            portalColumn
              ? 'w-[calc(100%-2rem)] max-w-[750px]'
              : 'w-[calc(100%-1.5rem)] max-w-3xl sm:w-[calc(100%-2rem)]',
            'flex max-h-[min(70dvh,560px)] flex-col overflow-hidden',
            'rounded-2xl border shadow-2xl',
            'duration-200',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:slide-out-to-bottom-4 data-[state=open]:slide-in-from-bottom-4',
            dark
              ? 'border-zinc-800 bg-zinc-950 text-zinc-100'
              : 'border-border bg-surface text-text',
          )}
        >
          <div className="mx-auto mt-2 h-1.5 w-12 shrink-0 rounded-full bg-border" aria-hidden />
          <header className={cn(
            'flex shrink-0 items-center gap-2 px-4 pb-2 pt-1',
            dark ? 'text-zinc-100' : 'text-text',
          )}
          >
            <Coins className={cn('h-4 w-4 shrink-0', dark ? 'text-teal-400' : 'text-teal-600')} />
            <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-[15px] font-semibold">
              {t('chat.statusBar.pointsTitle', { defaultValue: 'Points' })}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              className={cn(
                'rounded-md p-1.5 transition',
                dark
                  ? 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'
                  : 'text-text-dim hover:bg-surface-2 hover:text-text',
              )}
              aria-label={t('actions.close', { defaultValue: 'Close' })}
            >
              <X className="h-4 w-4" />
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-4 pb-4">
            {loading && !balance ? (
              <p className={cn('text-sm', dark ? 'text-zinc-500' : 'text-text-muted')}>
                {t('states.loading', { defaultValue: 'Loading…' })}
              </p>
            ) : !balance ? (
              <p className={cn('text-sm', dark ? 'text-zinc-500' : 'text-text-muted')}>
                {t('chat.statusBar.pointsNone', { defaultValue: 'Sign in to see your quota.' })}
              </p>
            ) : (
              <>
                <section className="space-y-2">
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <p className={cn('text-[11px]', dark ? 'text-zinc-500' : 'text-text-muted')}>
                        {t('chat.statusBar.pointsRemaining', { defaultValue: 'Remaining' })}
                      </p>
                      <p className="text-2xl font-semibold tabular-nums">
                        {balance.unlimited
                          ? t('chat.statusBar.pointsUnlimitedShort', { defaultValue: 'Unlimited' })
                          : formatPointsCompact(balance.remaining)}
                      </p>
                    </div>
                    <p className={cn('text-right text-xs tabular-nums', dark ? 'text-zinc-400' : 'text-text-dim')}>
                      {t('chat.statusBar.pointsUsedOf', {
                        used: formatPointsCompact(used),
                        limit: formatPointsCompact(cap || balance.monthlyLimit),
                        defaultValue: '{{used}} used / {{limit}}',
                      })}
                      {balance.bonus > 0
                        ? ` · ${t('chat.statusBar.pointsBonus', {
                          bonus: formatPointsCompact(balance.bonus),
                          defaultValue: '+{{bonus}} bonus',
                        })}`
                        : null}
                    </p>
                  </div>
                  {!balance.unlimited && (
                    <div className={cn('h-1.5 overflow-hidden rounded-full', dark ? 'bg-zinc-800' : 'bg-zinc-200')}>
                      <div
                        className={cn(
                          'h-full rounded-full',
                          ratio >= 0.9 ? 'bg-red-500' : ratio >= 0.7 ? 'bg-amber-500' : dark ? 'bg-teal-400' : 'bg-teal-600',
                        )}
                        style={{ width: `${Math.round(ratio * 100)}%` }}
                      />
                    </div>
                  )}
                </section>

                <section className="space-y-1.5">
                  <h3 className={cn(
                    'text-[11px] font-semibold uppercase tracking-wide',
                    dark ? 'text-zinc-500' : 'text-text-muted',
                  )}
                  >
                    {t('chat.statusBar.pointsDaily', { defaultValue: 'Daily spend' })}
                  </h3>
                  <DailySpendChart
                    daily={daily}
                    dark={dark}
                    label={t('chat.statusBar.pointsDaily', { defaultValue: 'Daily spend' })}
                    emptyLabel={t('chat.statusBar.pointsDailyEmpty', { defaultValue: 'No spend in the last 14 days.' })}
                  />
                </section>

                <section className="space-y-1.5">
                  <h3 className={cn(
                    'text-[11px] font-semibold uppercase tracking-wide',
                    dark ? 'text-zinc-500' : 'text-text-muted',
                  )}
                  >
                    {t('chat.statusBar.pointsRecent', { defaultValue: 'Recent activity' })}
                  </h3>
                  {recent.length === 0 ? (
                    <p className={cn('text-xs', dark ? 'text-zinc-500' : 'text-text-muted')}>
                      {t('chat.statusBar.pointsRecentEmpty', { defaultValue: 'No billed turns yet.' })}
                    </p>
                  ) : (
                    <ul className="space-y-1.5">
                      {recent.map((row) => (
                        <li
                          key={row.id}
                          className={cn(
                            'flex items-baseline justify-between gap-3 rounded-lg px-2 py-1.5 text-xs',
                            dark ? 'bg-zinc-900' : 'bg-zinc-50',
                          )}
                        >
                          <span className="min-w-0">
                            <span className="block truncate font-medium">
                              {reasonLabel(t, row.reason)}
                              {row.model ? ` · ${row.model}` : ''}
                            </span>
                            <span className={cn('tabular-nums', dark ? 'text-zinc-500' : 'text-text-muted')}>
                              {formatDayTime(row.at, locale)}
                            </span>
                          </span>
                          <span className={cn(
                            'shrink-0 tabular-nums font-medium',
                            row.delta > 0 && (dark ? 'text-teal-400' : 'text-teal-700'),
                          )}
                          >
                            {row.delta > 0
                              ? `+${formatPointsCompact(row.delta)}`
                              : formatPointsCompact(row.delta)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
