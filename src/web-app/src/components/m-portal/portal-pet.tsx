/**
 * PortalPet — Minecraft / Lego mosaic companion perched above the composer.
 *
 * - Mood follows run state; idle/tap still keep emotional phrases.
 * - Tap toggles a left-expanding panel of in-flight portal tasks
 *   (runs / approvals / asks).
 * - Completion announcements float left as drifting bubbles.
 */

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Loader2, MessageCircleQuestion, ShieldAlert, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export type PetTaskKind = 'run' | 'approval' | 'ask'

export interface PetTaskItem {
  id: string
  kind: PetTaskKind
  label: string
  detail?: string
}

export interface PetAnnounce {
  id: string
  text: string
  tone?: 'ok' | 'err'
}

export interface PortalPetProps {
  dark: boolean
  busy?: boolean
  className?: string
  /** In-flight work shown when the panel is open. */
  tasks?: PetTaskItem[]
  /** One-shot completion toast; floats left then clears. */
  announce?: PetAnnounce | null
  onAnnounceDone?: (id: string) => void
}

type Mood = 'idle' | 'busy' | 'happy'

/** 16×16 pixel art. Values are palette keys; `.` = empty. */
const IDLE: string[] = [
  '................',
  '......oooo......',
  '.....oooooo.....',
  '....oooooooo....',
  '...ooYooooYoo...',
  '...oooooooooo...',
  '..oooooooooooo..',
  '..ooEEooooEEoo..',
  '..ooEEooooEEoo..',
  '..oooooooooooo..',
  '...ooooMMoooo...',
  '...oooooooooo...',
  '....oooooOoo....',
  '.....oooooo.....',
  '......o..o......',
  '......o..o......',
]

const BUSY: string[] = [
  '................',
  '......oooo......',
  '.....oooooo.....',
  '....oooooooo....',
  '...ooYooooYoo...',
  '...oooooooooo...',
  '..oooooooooooo..',
  '..ooXXooooXXoo..',
  '..oooooooooooo..',
  '..oooooooooooo..',
  '...oooooooooo...',
  '...ooooMMoooo...',
  '....oooooooo....',
  '.....oooooo.....',
  '......o..o......',
  '......o..o......',
]

const HAPPY: string[] = [
  '................',
  '......oooo......',
  '.....oooooo.....',
  '....oooooooo....',
  '...ooYooooYoo...',
  '...oooooooooo...',
  '..oooooooooooo..',
  '..ooUUooooUUoo..',
  '..oooooooooooo..',
  '..oooooooooooo..',
  '...oooWMMWooo...',
  '...oooooooooo...',
  '....oooooOoo....',
  '.....oooooo.....',
  '......o..o......',
  '......o..o......',
]

function pickPhrase(list: unknown, fallback: string): string {
  const arr = Array.isArray(list) ? list as string[] : [fallback]
  return arr[Math.floor(Math.random() * arr.length)] ?? fallback
}

function palette(dark: boolean): Record<string, string> {
  // Match /m/login splash — rose / crimson pet (not teal).
  return {
    o: dark ? '#fb7185' : '#e11d48',
    Y: dark ? '#fecdd3' : '#fb7185',
    E: dark ? '#1c1917' : '#450a0a',
    X: dark ? '#1c1917' : '#450a0a',
    U: dark ? '#1c1917' : '#450a0a',
    M: dark ? '#fff1f2' : '#fda4af',
    W: dark ? '#fecdd3' : '#fecdd3',
    O: dark ? '#e11d48' : '#be123c',
  }
}

function PixelSprite({
  grid,
  colors,
}: {
  grid: string[]
  colors: Record<string, string>
}): JSX.Element {
  const cells: JSX.Element[] = []
  for (let y = 0; y < grid.length; y++) {
    const row = grid[y] ?? ''
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]
      if (!ch || ch === '.') continue
      const fill = colors[ch]
      if (!fill) continue
      cells.push(
        <rect
          key={`${x}-${y}`}
          x={x}
          y={y}
          width={1}
          height={1}
          fill={fill}
          shapeRendering="crispEdges"
        />,
      )
    }
  }
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-9 w-9"
      aria-hidden="true"
      style={{ imageRendering: 'pixelated' }}
    >
      <rect x={4} y={15} width={8} height={1} fill="#000" opacity="0.18" />
      {cells}
    </svg>
  )
}

function KindIcon({ kind, className }: { kind: PetTaskKind; className?: string }): JSX.Element {
  if (kind === 'approval') return <ShieldAlert className={className} />
  if (kind === 'ask') return <MessageCircleQuestion className={className} />
  return <Loader2 className={cn(className, 'animate-spin')} />
}

export function PortalPet({
  dark,
  busy,
  className,
  tasks = [],
  announce = null,
  onAnnounceDone,
}: PortalPetProps): JSX.Element {
  const { t } = useTranslation()
  const panelId = useId()
  const [mood, setMood] = useState<Mood>('idle')
  const [bubble, setBubble] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [floats, setFloats] = useState<PetAnnounce[]>([])
  const seenAnnounce = useRef<string | null>(null)

  useEffect(() => {
    setMood(busy ? 'busy' : 'idle')
  }, [busy])

  useEffect(() => {
    if (!bubble) return
    const id = window.setTimeout(() => setBubble(null), 1800)
    return () => window.clearTimeout(id)
  }, [bubble])

  // Queue completion toasts that drift left.
  useEffect(() => {
    if (!announce || announce.id === seenAnnounce.current) return
    seenAnnounce.current = announce.id
    setFloats((prev) => [...prev.slice(-4), announce])
    const clearId = window.setTimeout(() => {
      setFloats((prev) => prev.filter((f) => f.id !== announce.id))
      onAnnounceDone?.(announce.id)
    }, 2800)
    return () => window.clearTimeout(clearId)
  }, [announce, onAnnounceDone])

  // Close panel on outside tap.
  useEffect(() => {
    if (!open) return
    const onDoc = (ev: MouseEvent): void => {
      const root = document.getElementById(panelId)
      if (root && !root.contains(ev.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open, panelId])

  function onTap(): void {
    setOpen((v) => !v)
    setMood('happy')
    setBubble(null)
    if (!open) {
      // Opening panel — skip random emoji bubble.
      window.setTimeout(() => setMood(busy ? 'busy' : 'idle'), 900)
      return
    }
    window.setTimeout(() => {
      setBubble(pickPhrase(t('chat.portal.pet.tap', { returnObjects: true }), '♪'))
    }, 0)
    window.setTimeout(() => setMood(busy ? 'busy' : 'idle'), 900)
  }

  useEffect(() => {
    if (busy || open) return
    const id = window.setInterval(() => {
      if (document.hidden) return
      setBubble(pickPhrase(t('chat.portal.pet.idle', { returnObjects: true }), '♪'))
    }, 22_000)
    return () => window.clearInterval(id)
  }, [busy, open, t])

  useEffect(() => {
    if (!busy || open) return
    setBubble(pickPhrase(t('chat.portal.pet.running', { returnObjects: true }), '…'))
  }, [busy, open, t])

  const grid = mood === 'busy' ? BUSY : mood === 'happy' ? HAPPY : IDLE
  const colors = palette(dark)
  const taskCount = tasks.length

  return (
    <div id={panelId} className={cn('pointer-events-auto relative', className)}>
      {/* Completion floats — drift left from the pet. */}
      <div className="pointer-events-none absolute bottom-full right-0 z-50 mb-2 flex flex-col items-end gap-1.5">
        {floats.map((f) => (
          <div
            key={f.id}
            className={cn(
              'flex max-w-[14rem] items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold shadow-md',
              f.tone === 'err'
                ? (dark ? 'bg-red-950/90 text-red-200' : 'bg-red-50 text-red-700')
                : (dark ? 'bg-emerald-950/90 text-emerald-200' : 'bg-emerald-50 text-emerald-800'),
            )}
            style={{ animation: 'agim-pet-float-left 2.8s ease-out forwards' }}
          >
            {f.tone === 'err'
              ? <X className="h-3 w-3 shrink-0" />
              : <CheckCircle2 className="h-3 w-3 shrink-0" />}
            <span className="truncate">{f.text}</span>
          </div>
        ))}
      </div>

      {/* Left-expanding task panel */}
      {open && (
        <div
          className={cn(
            'absolute bottom-0 right-full mr-2 w-[min(16.5rem,72vw)] origin-bottom-right animate-in fade-in slide-in-from-right-2 rounded-2xl border p-2 shadow-xl duration-200',
            dark ? 'border-zinc-800 bg-zinc-950/95 text-zinc-100' : 'border-zinc-200 bg-white/95 text-zinc-800',
          )}
          role="dialog"
          aria-label={t('chat.portal.pet.panelTitle')}
        >
          <div className="mb-1.5 flex items-center justify-between px-1">
            <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
              {t('chat.portal.pet.panelTitle')}
            </p>
            <span className={cn(
              'rounded-full px-1.5 py-0.5 text-[9px] font-bold',
              taskCount > 0
                ? (dark ? 'bg-teal-500/20 text-teal-300' : 'bg-teal-50 text-teal-700')
                : 'bg-zinc-500/10 text-zinc-400',
            )}>
              {taskCount}
            </span>
          </div>
          {taskCount === 0 ? (
            <p className="px-1 py-3 text-center text-[11px] text-zinc-400">
              {t('chat.portal.pet.empty')}
            </p>
          ) : (
            <ul className="max-h-40 space-y-1 overflow-y-auto scrollbar-none">
              {tasks.map((item) => (
                <li
                  key={item.id}
                  className={cn(
                    'flex items-start gap-2 rounded-xl px-2 py-1.5 text-[11px]',
                    dark ? 'bg-zinc-900/80' : 'bg-zinc-50',
                  )}
                >
                  <KindIcon
                    kind={item.kind}
                    className={cn(
                      'mt-0.5 h-3.5 w-3.5 shrink-0',
                      item.kind === 'approval' ? 'text-amber-400'
                        : item.kind === 'ask' ? 'text-sky-400'
                          : 'text-teal-500',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-semibold">{item.label}</p>
                    {item.detail && (
                      <p className="mt-0.5 line-clamp-2 text-[10px] text-zinc-400">{item.detail}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Emotional bubble (hidden while panel open / floats active) */}
      {bubble && !open && floats.length === 0 && (
        <div
          className={cn(
            'absolute bottom-full left-1/2 mb-1.5 max-w-[9rem] -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-1 text-[10px] font-semibold shadow-md',
            dark ? 'bg-zinc-800 text-zinc-100' : 'bg-white text-zinc-700',
          )}
        >
          {bubble}
          <span
            className={cn(
              'absolute left-1/2 top-full -translate-x-1/2 border-4 border-transparent',
              dark ? 'border-t-zinc-800' : 'border-t-white',
            )}
          />
        </div>
      )}

      <button
        type="button"
        onClick={onTap}
        aria-expanded={open}
        aria-label={t('chat.portal.pet.aria', { defaultValue: 'Agim pet' })}
        className={cn(
          'relative flex h-11 w-11 items-center justify-center outline-none',
          'transition-transform active:scale-95',
          mood === 'busy' && 'animate-pulse',
        )}
        style={{
          animation: mood === 'idle'
            ? 'agim-pet-bob 2.8s ease-in-out infinite'
            : mood === 'happy'
              ? 'agim-pet-hop 0.55s ease-out'
              : undefined,
        }}
      >
        <PixelSprite grid={grid} colors={colors} />
        {taskCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-teal-500 px-0.5 text-[8px] font-bold text-white shadow">
            {taskCount > 9 ? '9+' : taskCount}
          </span>
        )}
      </button>
    </div>
  )
}
