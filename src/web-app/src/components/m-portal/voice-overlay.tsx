/**
 * Voice overlay — visual 1:1 with the design prototype (canvas aura).
 * Mic / refresh are UI-only for now (no STT backend yet).
 */

import { useEffect, useRef, useState } from 'react'
import { Mic, RefreshCw, Volume2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { agentVisual, displayAgentName } from './agent-visuals'

export interface VoiceOverlayProps {
  theme: 'dark' | 'light'
  agentId: string
  onClose: () => void
}

export function VoiceOverlay({ theme, agentId, onClose }: VoiceOverlayProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [muted, setMuted] = useState(false)
  const [voiceState, setVoiceState] = useState('Listening...')
  const [log, setLog] = useState<Array<{ id: string; text: string }>>([
    { id: 'seed', text: 'Tap the mic controls to simulate a voice turn.' },
  ])
  const visual = agentVisual(agentId)
  const Icon = visual.icon

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let animationId = 0
    let phase = 0

    const resize = (): void => {
      const parent = canvas.parentElement
      if (!parent) return
      canvas.width = parent.clientWidth * window.devicePixelRatio
      canvas.height = parent.clientHeight * window.devicePixelRatio
      ctx.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    const render = (): void => {
      const width = canvas.width / window.devicePixelRatio
      const height = canvas.height / window.devicePixelRatio
      ctx.clearRect(0, 0, width, height)

      const bgGrad = ctx.createRadialGradient(width / 2, height / 2, 10, width / 2, height / 2, width)
      if (theme === 'dark') {
        bgGrad.addColorStop(0, '#0a0a0d')
        bgGrad.addColorStop(1, '#020203')
      } else {
        bgGrad.addColorStop(0, '#ffffff')
        bgGrad.addColorStop(1, '#f1f5f9')
      }
      ctx.fillStyle = bgGrad
      ctx.fillRect(0, 0, width, height)

      let speed = 0.02
      let amplitude = 40
      let complexity = 4
      if (muted) {
        amplitude = 2
        speed = 0.005
      } else if (voiceState === 'Thinking...') {
        amplitude = 25
        speed = 0.08
        complexity = 6
      } else if (voiceState === 'Speaking...') {
        amplitude = 75
        speed = 0.05
        complexity = 5
      } else {
        amplitude = 35
        speed = 0.015
        complexity = 3
      }
      phase += speed

      const center = { x: width / 2, y: height * 0.45 }
      const baseRadius = Math.min(width, height) * 0.22

      ctx.save()
      ctx.globalCompositeOperation = theme === 'dark' ? 'screen' : 'multiply'
      const g1 = ctx.createRadialGradient(center.x, center.y, baseRadius * 0.3, center.x, center.y, baseRadius * 1.8)
      if (theme === 'dark') {
        g1.addColorStop(0, 'rgba(20, 184, 166, 0.4)')
        g1.addColorStop(0.5, 'rgba(13, 148, 136, 0.15)')
        g1.addColorStop(1, 'rgba(0, 0, 0, 0)')
      } else {
        g1.addColorStop(0, 'rgba(45, 212, 191, 0.35)')
        g1.addColorStop(0.5, 'rgba(204, 251, 241, 0.15)')
        g1.addColorStop(1, 'rgba(255, 255, 255, 0)')
      }
      ctx.fillStyle = g1
      ctx.beginPath()
      for (let angle = 0; angle < Math.PI * 2; angle += 0.05) {
        const offset = Math.sin(angle * complexity + phase) * amplitude * 0.5
          + Math.cos(angle * 2 - phase * 1.5) * amplitude * 0.3
        const r = baseRadius + offset
        const x = center.x + Math.cos(angle) * r
        const y = center.y + Math.sin(angle) * r
        if (angle === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.fill()
      ctx.restore()

      ctx.save()
      ctx.globalCompositeOperation = theme === 'dark' ? 'screen' : 'source-over'
      const g2 = ctx.createRadialGradient(center.x, center.y, baseRadius * 0.1, center.x, center.y, baseRadius * 1.2)
      if (theme === 'dark') {
        g2.addColorStop(0, 'rgba(14, 165, 233, 0.65)')
        g2.addColorStop(0.4, 'rgba(2, 132, 199, 0.25)')
        g2.addColorStop(1, 'rgba(0, 0, 0, 0)')
      } else {
        g2.addColorStop(0, 'rgba(56, 189, 248, 0.45)')
        g2.addColorStop(0.4, 'rgba(224, 242, 254, 0.2)')
        g2.addColorStop(1, 'rgba(255, 255, 255, 0)')
      }
      ctx.fillStyle = g2
      ctx.beginPath()
      for (let angle = 0; angle < Math.PI * 2; angle += 0.05) {
        const offset = Math.cos(angle * (complexity - 1) - phase * 1.2) * amplitude * 0.4
          + Math.sin(angle * 3 + phase) * amplitude * 0.25
        const r = baseRadius * 0.85 + offset
        const x = center.x + Math.cos(angle) * r
        const y = center.y + Math.sin(angle) * r
        if (angle === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.fill()
      ctx.restore()

      ctx.save()
      ctx.globalCompositeOperation = theme === 'dark' ? 'screen' : 'source-over'
      const g3 = ctx.createRadialGradient(center.x, center.y, 0, center.x, center.y, baseRadius * 0.7)
      if (theme === 'dark') {
        g3.addColorStop(0, 'rgba(255, 255, 255, 0.9)')
        g3.addColorStop(0.3, 'rgba(168, 85, 247, 0.4)')
        g3.addColorStop(0.7, 'rgba(139, 92, 246, 0.1)')
        g3.addColorStop(1, 'rgba(0, 0, 0, 0)')
      } else {
        g3.addColorStop(0, 'rgba(255, 255, 255, 0.95)')
        g3.addColorStop(0.3, 'rgba(192, 132, 252, 0.4)')
        g3.addColorStop(0.7, 'rgba(243, 232, 255, 0.15)')
        g3.addColorStop(1, 'rgba(255, 255, 255, 0)')
      }
      ctx.fillStyle = g3
      ctx.beginPath()
      for (let angle = 0; angle < Math.PI * 2; angle += 0.05) {
        const offset = Math.sin(angle * (complexity + 2) + phase * 2) * amplitude * 0.3
        const r = baseRadius * 0.5 + offset
        const x = center.x + Math.cos(angle) * r
        const y = center.y + Math.sin(angle) * r
        if (angle === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.fill()
      ctx.restore()

      animationId = requestAnimationFrame(render)
    }
    render()
    return () => {
      cancelAnimationFrame(animationId)
      window.removeEventListener('resize', resize)
    }
  }, [theme, voiceState, muted])

  return (
    <div className={cn(
      'absolute inset-0 z-50 flex flex-col justify-between p-6 animate-in fade-in duration-300',
      theme === 'dark' ? 'bg-[#020203]' : 'bg-[#f8fafc]',
    )}>
      <div className="pointer-events-none absolute inset-0 z-0 opacity-85">
        <canvas ref={canvasRef} className="h-full w-full" />
      </div>

      <div className="relative z-10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 animate-ping rounded-full bg-teal-400" />
          <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-400">Advanced Voice Mode</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className={cn(
            'rounded-full border p-2 transition-colors',
            theme === 'dark'
              ? 'border-zinc-800/50 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800'
              : 'border-zinc-200/50 bg-white/80 text-zinc-600 shadow-sm hover:bg-zinc-100',
          )}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="relative z-10 mt-16 flex flex-col items-center space-y-4 text-center">
        <div className={cn('rounded-3xl bg-gradient-to-tr p-4 text-white shadow-xl ring-4', visual.color, theme === 'dark' ? 'ring-neutral-900/60' : 'ring-black/5')}>
          <Icon className="h-9 w-9" />
        </div>
        <div>
          <h2 className={cn('text-xl font-black tracking-tight', theme === 'dark' ? 'text-white' : 'text-zinc-800')}>
            {displayAgentName(agentId)}
          </h2>
          <p className={cn(
            'mt-1.5 text-xs font-bold tracking-widest transition-all duration-300',
            voiceState === 'Speaking...' ? 'text-teal-500'
              : voiceState === 'Thinking...' ? 'animate-pulse text-purple-500'
                : 'text-zinc-400',
          )}>
            {voiceState}
          </p>
        </div>
      </div>

      <div className={cn(
        'relative z-10 flex min-h-[110px] w-full select-none flex-col justify-end space-y-1.5 rounded-2xl border p-4 text-left',
        theme === 'dark' ? 'border-zinc-900/50 bg-zinc-950/70' : 'border-zinc-200/80 bg-white/85 shadow-sm',
      )}>
        <p className="text-[8px] font-bold uppercase tracking-widest text-teal-500">Live Session Transcript</p>
        <div className="max-h-[85px] space-y-1 overflow-y-auto text-[11px] scrollbar-none">
          {log.map((entry) => (
            <p
              key={entry.id}
              className={cn(
                'leading-relaxed',
                entry.text.startsWith('User') ? 'font-semibold text-zinc-400'
                  : entry.text.startsWith('Agent') ? 'font-bold text-teal-600'
                    : 'text-zinc-400',
              )}
            >
              {entry.text}
            </p>
          ))}
        </div>
      </div>

      <div className="relative z-10 flex items-center justify-around py-4">
        <button
          type="button"
          onClick={() => {
            setMuted((m) => !m)
            setVoiceState(muted ? 'Listening...' : 'Muted')
          }}
          className={cn(
            'rounded-full border p-4 transition-colors',
            muted
              ? 'border-red-500/30 bg-red-500/20 text-red-500'
              : theme === 'dark'
                ? 'border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800'
                : 'border-zinc-200 bg-white text-zinc-600 shadow-sm hover:bg-zinc-50',
          )}
        >
          {muted ? <Volume2 className="h-5 w-5 animate-pulse text-red-500" /> : <Mic className="h-5 w-5" />}
        </button>
        <button
          type="button"
          onClick={() => {
            setVoiceState('Thinking...')
            setLog((prev) => [...prev, { id: `u-${Date.now()}`, text: 'User: (tap refresh) Continue…' }])
            window.setTimeout(() => {
              setVoiceState('Speaking...')
              setLog((prev) => [...prev, {
                id: `a-${Date.now()}`,
                text: `Agent: Sure — adjusting for ${displayAgentName(agentId)}.`,
              }])
            }, 1200)
          }}
          className={cn(
            'rounded-full border p-4 transition-colors',
            theme === 'dark'
              ? 'border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:bg-zinc-800'
              : 'border-zinc-200 bg-white text-zinc-600 shadow-sm hover:bg-zinc-50',
          )}
        >
          <RefreshCw className="h-5 w-5" />
        </button>
      </div>
    </div>
  )
}
