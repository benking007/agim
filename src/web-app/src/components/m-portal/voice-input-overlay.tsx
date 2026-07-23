/**
 * Hold-to-talk voice input HUD (WeChat / iMessage style).
 *
 * - Listening: blue「我在听」+ green arc with translucent ripple
 * - Cancel zone (finger slides up): gray arc + red「松开取消」
 * - Parent owns pointer lifecycle; this component is visual + level meter.
 */

import { Mic } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export type VoiceInputPhase = 'listening' | 'cancel' | 'transcribing'

export interface VoiceInputOverlayProps {
  phase: VoiceInputPhase
  /** 0..1 amplitude for ripple scale */
  level?: number
  dark?: boolean
}

export function VoiceInputOverlay({
  phase,
  level = 0.35,
  dark = false,
}: VoiceInputOverlayProps): JSX.Element {
  const { t } = useTranslation()
  const cancelling = phase === 'cancel'
  const busy = phase === 'transcribing'
  // Keep ripple amplitude modest so the halo stays within the shorter band.
  const pulse = 1 + Math.min(0.45, Math.max(0.08, level)) * 0.28

  const hint = busy
    ? t('chat.portal.voiceTranscribing', { defaultValue: '正在识别…' })
    : cancelling
      ? t('chat.portal.voiceReleaseCancel', { defaultValue: '松开取消' })
      : t('chat.portal.voiceListening', { defaultValue: '我在听' })

  return (
    <div
      role="status"
      className={cn(
        'pointer-events-none fixed inset-0 z-[80] flex flex-col',
        dark ? 'bg-zinc-950/45' : 'bg-zinc-900/25',
      )}
      aria-live="polite"
      aria-label={hint}
    >
      <div className="flex flex-1 items-center justify-center px-6">
        <p
          className={cn(
            'rounded-full px-5 py-2 text-center text-[17px] font-medium tracking-wide backdrop-blur-md',
            dark ? 'bg-zinc-950/75' : 'bg-white/90',
            cancelling ? 'text-rose-500' : 'text-sky-500',
            busy && 'animate-pulse text-sky-500',
          )}
        >
          {hint}
        </p>
      </div>

      {/* Bottom arc + translucent ripple + mic (≈ half prior 42vh band).
          No overflow-hidden — clipping the radial halo caused a hard horizontal line. */}
      <div className="relative h-[21vh] w-full overflow-visible">
        {/* Soft ripple halo — fades out via gradient + mask, never a clipped edge */}
        {!busy && (
          <div
            className="pointer-events-none absolute inset-x-[-10%] bottom-[-70%] mx-auto aspect-square max-w-none rounded-full"
            style={{
              width: '120%',
              left: '-10%',
              transform: `scale(${pulse})`,
              transition: 'transform 80ms linear',
              background: cancelling
                ? 'radial-gradient(circle at 50% 42%, rgba(161,161,170,0.45) 0%, rgba(161,161,170,0.16) 28%, rgba(161,161,170,0.05) 44%, transparent 62%)'
                : 'radial-gradient(circle at 50% 42%, rgba(52,199,89,0.5) 0%, rgba(52,199,89,0.2) 28%, rgba(52,199,89,0.06) 44%, transparent 62%)',
              WebkitMaskImage: 'linear-gradient(to top, #000 35%, transparent 92%)',
              maskImage: 'linear-gradient(to top, #000 35%, transparent 92%)',
            }}
          />
        )}

        {/* Solid / gray arc body */}
        <div
          className={cn(
            'absolute inset-x-0 bottom-0 h-[62%] rounded-t-[100%]',
            cancelling ? 'bg-zinc-300/95' : 'bg-[#34c759]',
            busy && 'bg-[#34c759]/80',
          )}
        />

        {/* Inner translucent band (second ripple) */}
        {!cancelling && !busy && (
          <div
            className="absolute inset-x-[10%] bottom-[14%] h-[18%] rounded-t-[100%] bg-white/25"
            style={{
              transform: `scaleY(${0.85 + level * 0.3})`,
              transformOrigin: 'bottom center',
              transition: 'transform 80ms linear',
            }}
          />
        )}

        <div className="absolute inset-x-0 bottom-[12%] flex justify-center">
          <div
            className={cn(
              'flex h-11 w-11 items-center justify-center rounded-full',
              cancelling ? 'bg-zinc-400/40' : 'bg-white/15',
            )}
          >
            <Mic className="h-6 w-6 text-white" strokeWidth={2.25} />
          </div>
        </div>
      </div>
    </div>
  )
}
