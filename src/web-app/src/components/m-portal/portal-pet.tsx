/**
 * PortalPet — Minecraft / Lego mosaic companion perched above the composer.
 * Tap for a reaction; mood follows run state.
 */

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface PortalPetProps {
  dark: boolean
  busy?: boolean
  className?: string
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
  return {
    o: dark ? '#2dd4bf' : '#14b8a6', // body
    Y: dark ? '#5eead4' : '#5eead4', // highlight ear
    E: dark ? '#0f172a' : '#134e4a', // eye
    X: dark ? '#0f172a' : '#134e4a', // busy dash eye
    U: dark ? '#0f172a' : '#134e4a', // happy eye
    M: dark ? '#f472b6' : '#fb7185', // mouth / blush
    W: dark ? '#f9a8d4' : '#fda4af', // smile cheek
    O: dark ? '#0d9488' : '#0f766e', // nose shade
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
      {/* soft ground shadow */}
      <rect x={4} y={15} width={8} height={1} fill="#000" opacity="0.18" />
      {cells}
    </svg>
  )
}

export function PortalPet({ dark, busy, className }: PortalPetProps): JSX.Element {
  const { t } = useTranslation()
  const [mood, setMood] = useState<Mood>('idle')
  const [bubble, setBubble] = useState<string | null>(null)

  useEffect(() => {
    setMood(busy ? 'busy' : 'idle')
  }, [busy])

  useEffect(() => {
    if (!bubble) return
    const id = window.setTimeout(() => setBubble(null), 1800)
    return () => window.clearTimeout(id)
  }, [bubble])

  function onTap(): void {
    setMood('happy')
    setBubble(null)
    window.setTimeout(() => {
      setBubble(pickPhrase(t('chat.portal.pet.tap', { returnObjects: true }), '♪'))
    }, 0)
    window.setTimeout(() => setMood(busy ? 'busy' : 'idle'), 900)
  }

  useEffect(() => {
    if (busy) return
    const id = window.setInterval(() => {
      if (document.hidden) return
      setBubble(pickPhrase(t('chat.portal.pet.idle', { returnObjects: true }), '♪'))
    }, 22_000)
    return () => window.clearInterval(id)
  }, [busy, t])

  useEffect(() => {
    if (!busy) return
    setBubble(pickPhrase(t('chat.portal.pet.running', { returnObjects: true }), '…'))
  }, [busy, t])

  const grid = mood === 'busy' ? BUSY : mood === 'happy' ? HAPPY : IDLE
  const colors = palette(dark)

  return (
    <div className={cn('pointer-events-auto relative', className)}>
      {bubble && (
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
      </button>
    </div>
  )
}
