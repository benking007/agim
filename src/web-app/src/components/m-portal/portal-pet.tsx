/**
 * PortalPet — small interactive 2D companion (Claude-style) perched
 * above the composer. Tap for a reaction; mood follows run state.
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

function pickPhrase(list: unknown, fallback: string): string {
  const arr = Array.isArray(list) ? list as string[] : [fallback]
  return arr[Math.floor(Math.random() * arr.length)] ?? fallback
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

  // Periodic idle whisper when quiet
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

  const bodyFill = dark ? '#2dd4bf' : '#14b8a6'
  const cheek = dark ? '#f472b6' : '#fb7185'
  const eye = dark ? '#0f172a' : '#134e4a'

  return (
    <div className={cn('pointer-events-auto relative', className)}>
      {bubble && (
        <div
          className={cn(
            'absolute bottom-full left-1/2 mb-1.5 max-w-[9rem] -translate-x-1/2 whitespace-nowrap rounded-2xl px-2.5 py-1 text-[10px] font-semibold shadow-md',
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
          'relative flex h-11 w-11 items-center justify-center rounded-full outline-none',
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
        <svg viewBox="0 0 64 64" className="h-9 w-9 drop-shadow-md" aria-hidden="true">
          <ellipse cx="32" cy="54" rx="16" ry="4" fill={dark ? '#000' : '#94a3b8'} opacity="0.25" />
          <path
            d="M12 34c0-12 9-22 20-22s20 10 20 22c0 10-7 18-20 18S12 44 12 34z"
            fill={bodyFill}
          />
          <ellipse cx="32" cy="40" rx="11" ry="9" fill={dark ? '#99f6e4' : '#ccfbf1'} opacity="0.85" />
          <circle cx="18" cy="36" r="3.2" fill={cheek} opacity="0.7" />
          <circle cx="46" cy="36" r="3.2" fill={cheek} opacity="0.7" />
          {mood === 'busy' ? (
            <>
              <path d="M22 30 h8" stroke={eye} strokeWidth="2.2" strokeLinecap="round" />
              <path d="M34 30 h8" stroke={eye} strokeWidth="2.2" strokeLinecap="round" />
            </>
          ) : mood === 'happy' ? (
            <>
              <path d="M22 31 q4 -5 8 0" fill="none" stroke={eye} strokeWidth="2.2" strokeLinecap="round" />
              <path d="M34 31 q4 -5 8 0" fill="none" stroke={eye} strokeWidth="2.2" strokeLinecap="round" />
            </>
          ) : (
            <>
              <circle cx="26" cy="30" r="3.2" fill={eye} />
              <circle cx="38" cy="30" r="3.2" fill={eye} />
              <circle cx="27" cy="29" r="1" fill="#fff" />
              <circle cx="39" cy="29" r="1" fill="#fff" />
            </>
          )}
          <path
            d="M27 42 q5 5 10 0"
            fill="none"
            stroke={eye}
            strokeWidth="2"
            strokeLinecap="round"
            opacity={mood === 'busy' ? 0.35 : 1}
          />
          <circle cx="32" cy="10" r="3" fill={cheek} />
          <path d="M32 13 v4" stroke={cheek} strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  )
}
