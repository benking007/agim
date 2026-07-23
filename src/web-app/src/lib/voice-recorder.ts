/**
 * Browser / WKWebView hold-to-talk recorder.
 *
 * Uses getUserMedia + MediaRecorder. Prefers audio/webm;codecs=opus, falls
 * back to audio/mp4 (Safari / iOS WKWebView). Exposes a smoothed RMS level
 * for the ripple HUD.
 */

export type VoiceRecorderMime = string

export interface VoiceRecorderResult {
  blob: Blob
  mime: string
  filename: string
  durationMs: number
}

export interface VoiceRecorderHandlers {
  onLevel?: (level: number) => void
  onError?: (err: Error) => void
}

function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/aac',
  ]
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c
  }
  return ''
}

function filenameForMime(mime: string): string {
  if (mime.includes('mp4') || mime.includes('aac') || mime.includes('m4a')) return 'voice.m4a'
  if (mime.includes('ogg')) return 'voice.ogg'
  return 'voice.webm'
}

/**
 * Why hold-to-talk cannot start. The old toast always blamed HTTPS, but
 * Safari / iOS WKWebView often fail on missing MediaRecorder even on https://.
 */
export type VoiceRecordingBlockReason =
  | 'insecure'
  | 'no-mediadevices'
  | 'no-mediarecorder'

export function getVoiceRecordingBlockReason(): VoiceRecordingBlockReason | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'no-mediadevices'
  }
  if (window.isSecureContext === false) return 'insecure'
  if (!navigator.mediaDevices?.getUserMedia) return 'no-mediadevices'
  if (typeof MediaRecorder === 'undefined') return 'no-mediarecorder'
  return null
}

export function isVoiceRecordingSupported(): boolean {
  return getVoiceRecordingBlockReason() === null
}

/**
 * Ideal constraints first; some Safari / WKWebView / Firefox builds reject
 * `channelCount` / `noiseSuppression` with DOMException "Invalid constraint".
 * Fall back to progressively looser audio constraints.
 */
export const VOICE_AUDIO_CONSTRAINT_CANDIDATES: MediaTrackConstraints[] = [
  {
    echoCancellation: true,
    noiseSuppression: true,
    channelCount: 1,
  },
  {
    echoCancellation: true,
    noiseSuppression: true,
  },
  {
    echoCancellation: true,
  },
  {},
]

function isInvalidConstraintError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; message?: string }
  const name = e.name || ''
  const message = e.message || ''
  return (
    name === 'OverconstrainedError'
    || name === 'ConstraintNotSatisfiedError'
    || /invalid constraint/i.test(message)
    || /overconstrained/i.test(message)
  )
}

/** Exported for unit tests — tries constraint candidates until one works. */
export async function getUserMediaAudio(
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
  candidates: MediaTrackConstraints[] = VOICE_AUDIO_CONSTRAINT_CANDIDATES,
): Promise<MediaStream> {
  let lastErr: unknown
  for (const audio of candidates) {
    try {
      return await getUserMedia({ audio: Object.keys(audio).length ? audio : true, video: false })
    } catch (err) {
      lastErr = err
      if (!isInvalidConstraintError(err)) throw err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export class VoiceRecorder {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private chunks: BlobPart[] = []
  private mime = ''
  private startedAt = 0
  private audioCtx: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private raf = 0
  private handlers: VoiceRecorderHandlers
  private stopped = false

  constructor(handlers: VoiceRecorderHandlers = {}) {
    this.handlers = handlers
  }

  async start(): Promise<void> {
    if (!isVoiceRecordingSupported()) {
      throw new Error('Voice recording is not supported in this browser')
    }
    this.stopped = false
    this.chunks = []
    this.mime = pickMimeType()
    this.stream = await getUserMediaAudio(
      (c) => navigator.mediaDevices.getUserMedia(c),
    )
    // User may have released / cancelled while the permission prompt was open.
    if (this.stopped) {
      this.cleanup()
      return
    }
    this.startedAt = Date.now()
    this.wireAnalyser(this.stream)

    const recorder = this.mime
      ? new MediaRecorder(this.stream, { mimeType: this.mime })
      : new MediaRecorder(this.stream)
    this.mime = recorder.mimeType || this.mime || 'audio/webm'
    this.recorder = recorder
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) this.chunks.push(ev.data)
    }
    recorder.onerror = () => {
      this.handlers.onError?.(new Error('MediaRecorder error'))
    }
    if (this.stopped) {
      this.cleanup()
      return
    }
    recorder.start(200)
  }

  private wireAnalyser(stream: MediaStream): void {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      this.audioCtx = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.75
      source.connect(analyser)
      this.analyser = analyser
      const data = new Uint8Array(analyser.fftSize)
      const tick = () => {
        if (this.stopped || !this.analyser) return
        this.analyser.getByteTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) {
          const sample = data[i]
          if (sample === undefined) continue
          const v = (sample - 128) / 128
          sum += v * v
        }
        const rms = Math.sqrt(sum / data.length)
        // Map to 0..1 with a gentle floor so the ripple always breathes.
        const level = Math.min(1, Math.max(0.12, rms * 3.2))
        this.handlers.onLevel?.(level)
        this.raf = requestAnimationFrame(tick)
      }
      this.raf = requestAnimationFrame(tick)
    } catch {
      // Analyser is optional — HUD can CSS-pulse without levels.
    }
  }

  async stop(): Promise<VoiceRecorderResult | null> {
    if (this.stopped) return null
    this.stopped = true
    const recorder = this.recorder
    const mime = this.mime || 'audio/webm'
    const startedAt = this.startedAt
    if (!recorder || recorder.state === 'inactive') {
      this.cleanup()
      return null
    }
    const blob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: mime }))
      }
      try {
        if (recorder.state === 'recording') recorder.requestData()
      } catch { /* older Safari */ }
      recorder.stop()
    })
    this.cleanup()
    if (!blob.size) return null
    return {
      blob,
      mime,
      filename: filenameForMime(mime),
      durationMs: Math.max(0, Date.now() - startedAt),
    }
  }

  cancel(): void {
    this.stopped = true
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    } catch { /* ignore */ }
    this.cleanup()
    this.chunks = []
  }

  private cleanup(): void {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.analyser = null
    if (this.audioCtx) {
      void this.audioCtx.close().catch(() => {})
      this.audioCtx = null
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop()
      this.stream = null
    }
    this.recorder = null
  }
}

export async function transcribeVoiceBlob(
  result: VoiceRecorderResult,
  opts?: { language?: string },
): Promise<{ text: string; provider: string; elapsedMs: number }> {
  const { useAuth } = await import('@/stores/auth')
  const tok = useAuth.getState().token
  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-Agim-Filename': encodeURIComponent(result.filename),
    'X-Agim-Mime': result.mime,
    'X-Agim-Language': opts?.language || 'zh',
  }
  if (tok) headers.Authorization = `Bearer ${tok}`
  const res = await fetch('/api/chat/transcribe', {
    method: 'POST',
    headers,
    body: result.blob,
  })
  if (!res.ok) {
    let message = `STT ${res.status}`
    try {
      const body = await res.json() as { message?: string; error?: string }
      message = body.message || body.error || message
    } catch {
      const text = await res.text().catch(() => '')
      if (text) message = text.slice(0, 200)
    }
    throw new Error(message)
  }
  return res.json() as Promise<{ text: string; provider: string; elapsedMs: number }>
}
