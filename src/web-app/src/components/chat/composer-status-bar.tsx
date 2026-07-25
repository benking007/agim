/**
 * ComposerStatusBar — Cursor-like row under the chat input:
 *   [model ▾]  Thinking ▾  high ▾          (context ring)
 *
 * Model dropdown lists sibling backends under the same preset; last item
 * opens the LLM settings dialog. Thinking / effort send `/think …`.
 * Context ring opens an approximate usage breakdown popover.
 */

import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Check, ChevronDown, Settings2, Shield, ShieldCheck, X } from 'lucide-react'
import { useComposerAutoApprove } from '@/hooks/use-composer-auto-approve'
import { toast } from 'sonner'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  COMPACT_RATE_OPTIONS,
  hardLineForCompactRate,
  isCompactRateSafe,
  normalizeCompactRate,
  type CompactRate,
} from '@/lib/compact-rate'
import { cn } from '@/lib/utils'

export type ThinkEffort = 'low' | 'high' | 'max'

export interface ContextBreakdownItem {
  key: string
  label: string
  tokens: number
  color: string
}

export interface ModelOption {
  backendName: string
  model: string
}

export interface ComposerStatusBarProps {
  dark?: boolean
  modelLabel: string
  modelMissing?: boolean
  /** Sibling models under the current preset (Agim). */
  modelOptions?: ModelOption[]
  activeBackendName?: string
  thinkVariant: string
  /** When false, hide thinking controls (non-Agim agents). */
  showThinking?: boolean
  contextUsed: number
  contextWindow: number
  breakdown?: ContextBreakdownItem[]
  /** Session-scoped compression rate (`auto` | `full` | `balanced` | `frequent`). */
  compactRate?: string
  disabled?: boolean
  onSelectModel?: (backendName: string) => void
  onConfigureModel: () => void
  onSendCommand: (cmd: string) => void
  className?: string
}

function normalizeVariant(raw: string): { on: boolean; effort: ThinkEffort } {
  const v = (raw || 'auto').trim().toLowerCase()
  if (v === 'off' || v === 'none') return { on: false, effort: 'high' }
  if (v === 'max' || v === 'xhigh') return { on: true, effort: 'max' }
  if (v === 'low') return { on: true, effort: 'low' }
  // auto / high / minimal / medium → on with high (DeepSeek clamps mid levels)
  return { on: true, effort: 'high' }
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 10_000) return `${(n / 1000).toFixed(1)}K`
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function ContextRing({
  ratio,
  dark,
  onClick,
}: {
  ratio: number
  dark?: boolean
  onClick: () => void
}): JSX.Element {
  const pct = Math.max(0, Math.min(1, ratio))
  const r = 6
  const c = 2 * Math.PI * r
  const dash = c * pct
  const stroke = pct >= 0.9 ? '#ef4444' : pct >= 0.7 ? '#f59e0b' : dark ? '#2dd4bf' : '#0d9488'
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-full transition-colors',
        dark ? 'hover:bg-zinc-800' : 'hover:bg-zinc-200/80',
      )}
      aria-label="Context usage"
      title={`${Math.round(pct * 100)}%`}
    >
      <svg width="18" height="18" viewBox="0 0 16 16" className="block" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke={dark ? '#52525b' : '#d4d4d8'}
          strokeWidth="2.25"
        />
        <circle
          cx="8"
          cy="8"
          r={r}
          fill="none"
          stroke={stroke}
          strokeWidth="2.25"
          strokeDasharray={`${dash} ${c - dash}`}
          strokeLinecap="round"
          transform="rotate(-90 8 8)"
        />
      </svg>
    </button>
  )
}

export function ComposerStatusBar({
  dark = false,
  modelLabel,
  modelMissing = false,
  modelOptions = [],
  activeBackendName,
  thinkVariant,
  showThinking = true,
  contextUsed,
  contextWindow,
  breakdown = [],
  compactRate = 'auto',
  disabled = false,
  onSelectModel,
  onConfigureModel,
  onSendCommand,
  className,
}: ComposerStatusBarProps): JSX.Element {
  const { t, i18n } = useTranslation()
  const [contextOpen, setContextOpen] = useState(false)
  const autoApprove = useComposerAutoApprove()
  const { on: thinkingOn, effort } = normalizeVariant(thinkVariant)
  const windowSize = Math.max(1, contextWindow || 32_000)
  const used = Math.max(0, contextUsed)
  const ratio = used / windowSize
  const pctLabel = Math.min(100, Math.round(ratio * 100))
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

  function setThinking(nextOn: boolean): void {
    if (disabled) return
    onSendCommand(nextOn ? `/think ${effort}` : '/think off')
  }

  function setEffort(next: ThinkEffort): void {
    if (disabled) return
    onSendCommand(`/think ${next}`)
  }

  const chip = cn(
    'inline-flex h-7 max-w-[11rem] items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors',
    'disabled:opacity-40',
    dark
      ? 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100'
      : 'text-zinc-600 hover:bg-zinc-200/80 hover:text-zinc-900',
  )

  return (
    <div
      className={cn(
        'relative flex items-center gap-1.5 px-1.5 pt-2',
        className,
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            className={cn(chip, modelMissing && (dark ? 'text-amber-400' : 'text-amber-600'))}
            title={t('chat.statusBar.modelHint', { defaultValue: 'Switch model or open LLM settings' })}
          >
            <span className="truncate">{modelLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[12rem]">
          {modelOptions.map((opt) => {
            const active = opt.backendName === activeBackendName
            return (
              <DropdownMenuItem
                key={opt.backendName}
                onSelect={() => onSelectModel?.(opt.backendName)}
                className="font-mono text-xs"
              >
                <Check className={cn('h-3.5 w-3.5', active ? 'opacity-100' : 'opacity-0')} />
                <span className="truncate">{opt.model}</span>
              </DropdownMenuItem>
            )
          })}
          {modelOptions.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => onConfigureModel()}>
            <Settings2 className="h-3.5 w-3.5" />
            <span>{t('chat.statusBar.configureLlm', { defaultValue: 'Configure models…' })}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {showThinking && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild disabled={disabled}>
              <button type="button" className={chip}>
                <Brain className={cn('h-3 w-3', thinkingOn ? (dark ? 'text-teal-400' : 'text-teal-600') : 'opacity-50')} />
                <span>
                  {thinkingOn
                    ? t('chat.statusBar.thinkingOn', { defaultValue: 'Thinking' })
                    : t('chat.statusBar.thinkingOff', { defaultValue: 'Think off' })}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[8rem]">
              <DropdownMenuItem onSelect={() => setThinking(true)}>
                {t('chat.statusBar.thinkingOn', { defaultValue: 'Thinking' })}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setThinking(false)}>
                {t('chat.statusBar.thinkingOff', { defaultValue: 'Think off' })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {thinkingOn && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={disabled}>
                <button type="button" className={chip}>
                  <span>{effort}</span>
                  <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[7rem]">
                <DropdownMenuItem onSelect={() => setEffort('low')}>low</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setEffort('high')}>high</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setEffort('max')}>max</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled || autoApprove.loading || autoApprove.setting}>
          <button
            type="button"
            className={chip}
            title={t('chat.statusBar.autoApproveHint', {
              defaultValue: 'Main agent tool approvals — auto-approve on your behalf, or ask each time',
            })}
          >
            {autoApprove.enabled
              ? <ShieldCheck className={cn('h-3 w-3', dark ? 'text-teal-400' : 'text-teal-600')} />
              : <Shield className="h-3 w-3 opacity-60" />}
            <span>
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

      <div className="ml-auto flex items-center">
        <ContextRing ratio={ratio} dark={dark} onClick={() => setContextOpen(true)} />
      </div>

      {contextOpen && (
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
              onClick={() => setContextOpen(false)}
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
      )}
    </div>
  )
}

/** Rough char→token estimate for the composer context ring. */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0
  return Math.max(0, Math.ceil(text.length / 4))
}

export function estimateContextWindow(model: string | undefined): number {
  const m = (model || '').toLowerCase()
  // Keep in sync with pi catalog / provider-resolver vendor fallbacks.
  // Prefer GET /api/llm `contextWindow` (catalog-enriched) when available.
  if (
    m.includes('kimi-k3')
    || m.includes('glm-5')
    || m.includes('mimo-v2.5')
    || m.includes('deepseek-v4')
    || m.includes('deepseek-v3')
  ) {
    return 1_000_000
  }
  if (m.includes('kimi-k2')) return 256_000
  if (m.includes('glm-4.7')) return 200_000
  if (m.includes('claude') || m.includes('gpt-4') || m.includes('gpt-5')) return 200_000
  if (m.includes('deepseek')) return 1_000_000
  return 32_000
}
