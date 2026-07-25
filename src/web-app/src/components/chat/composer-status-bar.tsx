/**
 * ComposerStatusBar — Cursor-like row under the chat input:
 *   [model ▾]  Thinking ▾  high ▾          (context ring)
 *
 * Model dropdown lists sibling backends under the same preset; last item
 * opens the LLM settings dialog. Thinking / effort send `/think …`.
 * Context ring opens an approximate usage breakdown popover.
 */

import { lazy, Suspense, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Brain, Check, ChevronDown, Settings2 } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

const ComposerAutoApproveChip = lazy(async () => {
  const module = await import('@/components/chat/composer-auto-approve-chip')
  return { default: module.ComposerAutoApproveChip }
})

const ComposerContextPopover = lazy(async () => {
  const module = await import('@/components/chat/composer-context-popover')
  return { default: module.ComposerContextPopover }
})

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
  const { t } = useTranslation()
  const [contextOpen, setContextOpen] = useState(false)
  const { on: thinkingOn, effort } = normalizeVariant(thinkVariant)
  const windowSize = Math.max(1, contextWindow || 32_000)
  const used = Math.max(0, contextUsed)
  const ratio = used / windowSize

  function setThinking(nextOn: boolean): void {
    if (disabled) return
    onSendCommand(nextOn ? `/think ${effort}` : '/think off')
  }

  function setEffort(next: ThinkEffort): void {
    if (disabled) return
    onSendCommand(`/think ${next}`)
  }

  const chip = cn(
    // shrink-0 + nowrap: narrow Portal widths must not crush Chinese labels
    // into a vertical stack ("思 / 考 / 开"). Overflow scrolls horizontally.
    'inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 text-xs font-medium transition-colors',
    'disabled:opacity-40',
    dark
      ? 'text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100'
      : 'text-zinc-600 hover:bg-zinc-200/80 hover:text-zinc-900',
  )

  return (
    <div
      className={cn(
        'relative flex min-w-0 items-center gap-1 px-1.5 pt-2',
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overscroll-x-contain [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild disabled={disabled}>
            <button
              type="button"
              className={cn(
                chip,
                'max-w-[11rem]',
                modelMissing && (dark ? 'text-amber-400' : 'text-amber-600'),
              )}
              title={t('chat.statusBar.modelHint', { defaultValue: 'Switch model or open LLM settings' })}
            >
              <span className="min-w-0 truncate">{modelLabel}</span>
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
                  <Brain className={cn('h-3 w-3 shrink-0', thinkingOn ? (dark ? 'text-teal-400' : 'text-teal-600') : 'opacity-50')} />
                  <span className="whitespace-nowrap">
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
                    <span className="whitespace-nowrap">{effort}</span>
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

        <Suspense
          fallback={(
            <button
              type="button"
              className={chip}
              disabled
              title={t('chat.statusBar.autoApproveHint', {
                defaultValue: 'Main agent tool approvals — auto-approve on your behalf, or ask each time',
              })}
            >
              <span className="whitespace-nowrap">{t('chat.statusBar.autoApproveOff', { defaultValue: 'Ask to approve' })}</span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
            </button>
          )}
        >
          <ComposerAutoApproveChip dark={dark} disabled={disabled} chipClassName={chip} />
        </Suspense>
      </div>

      <div className="ml-0.5 flex shrink-0 items-center">
        <ContextRing ratio={ratio} dark={dark} onClick={() => setContextOpen(true)} />
      </div>

      {contextOpen && (
        <Suspense fallback={null}>
          <ComposerContextPopover
            dark={dark}
            disabled={disabled}
            contextUsed={used}
            contextWindow={windowSize}
            breakdown={breakdown}
            compactRate={compactRate}
            onSendCommand={onSendCommand}
            onClose={() => setContextOpen(false)}
          />
        </Suspense>
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
