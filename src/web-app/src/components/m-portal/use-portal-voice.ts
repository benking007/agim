import { useCallback, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  getVoiceRecordingBlockReason,
  isVoiceRecordingSupported,
  transcribeVoiceBlob,
  VoiceRecorder,
} from '@/lib/voice-recorder'
import type { VoiceInputPhase } from './voice-input-overlay'

interface UsePortalVoiceOptions {
  canStop: boolean
  uploading: boolean
  lang: string
  connectionStatus: string
  /** Called with the raw transcript text when recording succeeds. */
  onTranscribed: (text: string) => void
}

export interface UsePortalVoiceReturn {
  voicePhase: VoiceInputPhase | null
  voiceLevel: number
  onVoicePointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onVoicePointerMove: (e: ReactPointerEvent<HTMLButtonElement>) => void
  onVoicePointerUp: (e: ReactPointerEvent<HTMLButtonElement>) => void
}

export function usePortalVoice({
  canStop,
  uploading,
  lang,
  connectionStatus,
  onTranscribed,
}: UsePortalVoiceOptions): UsePortalVoiceReturn {
  const { t } = useTranslation()
  const [voicePhase, setVoicePhase] = useState<VoiceInputPhase | null>(null)
  const [voiceLevel, setVoiceLevel] = useState(0.3)
  const voiceRecorderRef = useRef<VoiceRecorder | null>(null)
  const voiceCancelRef = useRef(false)
  const voiceStartYRef = useRef(0)
  const voiceActiveRef = useRef(false)

  const endVoiceSession = useCallback(async (cancelled: boolean) => {
    if (!voiceActiveRef.current && !voiceRecorderRef.current) {
      setVoicePhase(null)
      return
    }
    voiceActiveRef.current = false
    const recorder = voiceRecorderRef.current
    voiceRecorderRef.current = null
    if (!recorder) {
      setVoicePhase(null)
      return
    }
    if (cancelled) {
      recorder.cancel()
      setVoicePhase(null)
      setVoiceLevel(0.3)
      return
    }
    setVoicePhase('transcribing')
    try {
      const clip = await recorder.stop()
      if (!clip || clip.durationMs < 280) {
        toast.error(t('chat.portal.voiceTooShort', { defaultValue: '说话时间太短' }))
        setVoicePhase(null)
        return
      }
      if (connectionStatus !== 'open') {
        toast.error('Not connected')
        setVoicePhase(null)
        return
      }
      const { text } = await transcribeVoiceBlob(clip, {
        language: lang === 'zh' ? 'zh' : 'en',
      })
      const trimmed = text.trim()
      if (!trimmed) {
        toast.error(t('chat.portal.voiceEmpty', { defaultValue: '没有识别到语音' }))
        setVoicePhase(null)
        return
      }
      onTranscribed(trimmed)
      setVoicePhase(null)
      toast.success(t('chat.portal.voiceFilled', {
        defaultValue: '已填入输入框，确认后发送',
      }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('chat.portal.voiceFailed', {
        defaultValue: '语音识别失败',
      }))
      setVoicePhase(null)
    } finally {
      setVoiceLevel(0.3)
    }
  }, [lang, connectionStatus, onTranscribed, t])

  const onVoicePointerDown = useCallback(async (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (canStop || uploading || voicePhase === 'transcribing') return
    const voiceBlock = getVoiceRecordingBlockReason()
    if (voiceBlock) {
      const msg = voiceBlock === 'insecure'
        ? t('chat.portal.voiceInsecure', {
          defaultValue: '当前不是安全上下文，浏览器禁止录音。请用 https:// 打开（不要用 http://），或用 localhost',
        })
        : voiceBlock === 'no-mediarecorder'
          ? t('chat.portal.voiceNoMediaRecorder', {
            defaultValue: '当前浏览器/壳不支持 MediaRecorder（常见于旧版 iOS Safari）。请升级系统，或改用桌面 Chrome/Edge',
          })
          : t('chat.portal.voiceNoMediaDevices', {
            defaultValue: '无法访问麦克风 API（mediaDevices）。请确认用 https 打开、未禁用麦克风权限，且不在无权限的 iframe 内',
          })
      toast.error(msg)
      return
    }
    if (!isVoiceRecordingSupported()) {
      toast.error(t('chat.portal.voiceUnsupported', {
        defaultValue: '当前环境不支持录音',
      }))
      return
    }
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    voiceStartYRef.current = e.clientY
    voiceCancelRef.current = false
    voiceActiveRef.current = true
    setVoicePhase('listening')
    setVoiceLevel(0.3)
    const recorder = new VoiceRecorder({
      onLevel: (level) => setVoiceLevel(level),
      onError: (err) => toast.error(err.message),
    })
    voiceRecorderRef.current = recorder
    try {
      await recorder.start()
      // Released / cancelled while awaiting getUserMedia — drop the session.
      if (!voiceActiveRef.current || voiceRecorderRef.current !== recorder) {
        recorder.cancel()
        if (voiceRecorderRef.current === recorder) voiceRecorderRef.current = null
        if (!voiceActiveRef.current) setVoicePhase(null)
      }
    } catch (err) {
      voiceActiveRef.current = false
      voiceRecorderRef.current = null
      setVoicePhase(null)
      const msg = err instanceof Error ? err.message : String(err)
      const name = err instanceof DOMException || (err && typeof err === 'object' && 'name' in err)
        ? String((err as { name?: string }).name || '')
        : ''
      toast.error(
        /Permission|NotAllowed|denied/i.test(msg) || name === 'NotAllowedError'
          ? t('chat.portal.voiceDenied', { defaultValue: '需要麦克风权限才能语音输入' })
          : /Requested device not found|NotFound|DevicesNotFound|no.*device/i.test(msg)
            || name === 'NotFoundError'
            || name === 'DevicesNotFoundError'
            ? t('chat.portal.voiceNoDevice', {
              defaultValue: '浏览器找不到麦克风。请确认：电脑已接麦/耳机麦、系统未禁用输入设备，且不是远程桌面无音频透传；然后刷新页面再试',
            })
            : /Invalid constraint|Overconstrained|constraint/i.test(msg)
              ? t('chat.portal.voiceConstraint', {
                defaultValue: '无法打开麦克风（未弹出权限框）。请：① 硬刷新页面或重启 Agim；② 系统设置 → 隐私 → 麦克风，允许浏览器/Agim；③ 地址栏站点权限里麦克风选「允许」',
              })
              : msg,
      )
    }
  }, [canStop, t, uploading, voicePhase])

  const onVoicePointerMove = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!voiceActiveRef.current || voicePhase === 'transcribing') return
    const dy = voiceStartYRef.current - e.clientY
    const cancel = dy > 72
    if (cancel !== voiceCancelRef.current) {
      voiceCancelRef.current = cancel
      setVoicePhase(cancel ? 'cancel' : 'listening')
    }
  }, [voicePhase])

  const onVoicePointerUp = useCallback((e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!voiceActiveRef.current && voicePhase !== 'listening' && voicePhase !== 'cancel') return
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    const cancelled = voiceCancelRef.current
    void endVoiceSession(cancelled)
  }, [endVoiceSession, voicePhase])

  return {
    voicePhase,
    voiceLevel,
    onVoicePointerDown: (e) => { void onVoicePointerDown(e) },
    onVoicePointerMove,
    onVoicePointerUp,
  }
}
