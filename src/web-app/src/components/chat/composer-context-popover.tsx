import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

import {
  COMPACT_RATE_OPTIONS,
  hardLineForCompactRate,
  isCompactRateSafe,
  normalizeCompactRate,
  type CompactRate,
} from '@/lib/compact-rate'
import { cn } from '@/lib/utils'
import type { ContextBreakdownItem } from '@/components/chat/composer-status-bar'

export interface ComposerContextPopoverProps {
  dark?: boolean
  disabled?: boolean
  contextUsed: number
  contextWindow: number
  breakdown: ContextBreakdownItem[]
  compactRate: string
  onSendCommand: (cmd: string) => void
  onClose: () => void
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function ComposerContextPopover({
  dark = false,
  disabled = false,
  contextUsed,
  contextWindow,
  breakdown,
  compactRate,
  onSendCommand,
  onClose,
}: ComposerContextPopoverProps): JSX.Element {
  const { t, i18n } = useTranslation()
  const used = Math.max(0, contextUsed)
  const windowSize = Math.max(1, contextWindow)
  const pctLabel = Math.min(100, Math.round((used / windowSize) * 100))
  const rate = normalizeCompactRate(compactRate)
  const zh = (i18n.language || '').startsWith('zh')
  const hardLine = hardLineForCompactRate(windowSize, rate)

  function compactRateLabel(id: CompactRate): string {
    if (zh) {
      if (id === 'auto') return '自动'
      if (id === 'full') return '满压'
      if (id === 'balanced') return '均衡'
      return '频繁'
    }
    if (id === 'auto') return 'Auto'
    if (id === 'full') return 'Full'
    if (id === 'balanced') return 'Balanced'
    return 'Frequent'
  }

  function setCompactRate(next: CompactRate): void {
    if (disabled) return
    if (!isCompactRateSafe(windowSize, used, next)) return
    onSendCommand(`/ctx ${next}`)
  }

  const segments = useMemo(() => {
    const items = breakdown.length > 0
      ? breakdown
      : [{
          key: 'conversation',
          label: t('chat.statusBar.conversation', { defaultValue: 'Conversation' }),
          tokens: used,
          color: '#ef4444',
        }]
    const sum = items.reduce((n, i) => n + i.tokens, 0)
    const free = Math.max(0, windowSize - sum)
    return [
      ...items.filter((i) => i.tokens > 0),
      {
        key: 'free',
        label: t('chat.statusBar.free', { defaultValue: 'Free' }),
        tokens: free,
        color: dark ? '#3f3f46' : '#e4e4e7',
      },
    ]
  }, [breakdown, used, windowSize, dark, t])

  return (
    <div
      className={cn(
        'absolute bottom-full right-0 z-50 mb-2 w-[min(20rem,calc(100vw-2rem))] rounded-xl border p-3 shadow-xl',
        dark ? 'border-zinc-700 bg-zinc-900 text-zinc-100' : 'border-zinc-200 bg-white text-zinc-900',
      )}
      role="dialog"
      aria-label={t('chat.statusBar.contextTitle', { defaultValue: 'Context Usage' })}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold">
            {t('chat.statusBar.contextTitle', { defaultValue: 'Context Usage' })}
          </div>
          <div className={cn('mt-0.5 text-xs', dark ? 'text-zinc-400' : 'text-zinc-500')}>
            <span className="mr-2">{pctLabel}% {t('chat.statusBar.full', { defaultValue: 'Full' })}</span>
            <span>~{formatTokens(used)} / {formatTokens(windowSize)} Tokens</span>
          </div>
        </div>
        <button
          type="button"
          className={cn(
            'rounded-md p-1',
            dark ? 'hover:bg-zinc-800' : 'hover:bg-zinc-100',
          )}
          onClick={onClose}
          aria-label={t('actions.close', { defaultValue: 'Close' })}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className={cn('mb-3 flex h-2 overflow-hidden rounded-full', dark ? 'bg-zinc-800' : 'bg-zinc-100')}>
        {segments.map((seg) => (
          <div
            key={seg.key}
            style={{
              width: `${Math.max(0.5, (seg.tokens / windowSize) * 100)}%`,
              backgroundColor: seg.color,
            }}
            title={`${seg.label}: ${formatTokens(seg.tokens)}`}
          />
        ))}
      </div>

      <ul className="space-y-1.5">
        {segments.map((seg) => (
          <li key={seg.key} className="flex items-center gap-2 text-xs">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: seg.color }}
            />
            <span className={cn('min-w-0 flex-1 truncate', dark ? 'text-zinc-300' : 'text-zinc-600')}>
              {seg.label}
            </span>
            <span className={cn('tabular-nums', dark ? 'text-zinc-400' : 'text-zinc-500')}>
              {formatTokens(seg.tokens)}
            </span>
          </li>
        ))}
      </ul>

      <div className={cn('mt-3 border-t pt-3', dark ? 'border-zinc-800' : 'border-zinc-100')}>
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <span className="text-xs font-medium">
            {t('chat.statusBar.compactRate', {
              defaultValue: zh ? '压缩率' : 'Compression rate',
            })}
          </span>
          <span className={cn('text-[10px] tabular-nums', dark ? 'text-zinc-500' : 'text-zinc-400')}>
            {t('chat.statusBar.hardLine', {
              defaultValue: zh ? '硬线' : 'Hard line',
            })}
            {' ~'}
            {formatTokens(hardLine)}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          {COMPACT_RATE_OPTIONS.map((opt) => {
            const safe = isCompactRateSafe(windowSize, used, opt.id)
            const active = rate === opt.id
            return (
              <button
                key={opt.id}
                type="button"
                disabled={disabled || !safe}
                title={!safe
                  ? (zh
                    ? '当前已用上下文过高，该档会使硬线低于已用量'
                    : 'Current usage is too high for this rate')
                  : undefined}
                onClick={() => setCompactRate(opt.id)}
                className={cn(
                  'rounded-md px-2 py-1 text-[11px] font-medium transition-colors',
                  active
                    ? (dark ? 'bg-teal-500/20 text-teal-300' : 'bg-teal-50 text-teal-800')
                    : (dark ? 'text-zinc-300 hover:bg-zinc-800' : 'text-zinc-600 hover:bg-zinc-100'),
                  (!safe || disabled) && 'cursor-not-allowed opacity-35 hover:bg-transparent',
                )}
              >
                {compactRateLabel(opt.id)}
              </button>
            )
          })}
        </div>
        <p className={cn('mt-1.5 text-[10px]', dark ? 'text-zinc-500' : 'text-zinc-400')}>
          {zh
            ? (rate === 'full'
              ? '满压：接近上限才压缩，优先保留原始上下文（仅本会话）'
              : rate === 'balanced'
                ? '均衡：中等预留，折中触发（仅本会话）'
                : rate === 'frequent'
                  ? '频繁：更早、更常压缩（仅本会话）'
                  : '自动：按当前模型窗口缩放（全局默认）')
            : (rate === 'full'
              ? 'Full: compact near the window ceiling (this session)'
              : rate === 'balanced'
                ? 'Balanced: mid reserve (this session)'
                : rate === 'frequent'
                  ? 'Frequent: compact earlier (this session)'
                  : 'Auto: follow the model window (global default)')}
        </p>
      </div>

      <p className={cn('mt-2 text-[10px]', dark ? 'text-zinc-500' : 'text-zinc-400')}>
        {t('chat.statusBar.contextApprox', {
          defaultValue: zh
            ? '近似拆分（字符/4 + 规则/技能/工具估算）；实时 tool 结果与压缩后会话可能未完全计入。'
            : 'Approximate breakdown (chars/4 + rules/skills/tools estimates). Live tool results and post-compact session size may not be fully reflected.',
        })}
      </p>
    </div>
  )
}
