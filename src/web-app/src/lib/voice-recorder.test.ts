import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getUserMediaAudio,
  getVoiceRecordingBlockReason,
  isVoiceRecordingSupported,
} from './voice-recorder'

describe('voice-recorder support probe', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports support based on browser APIs', () => {
    expect(typeof isVoiceRecordingSupported()).toBe('boolean')
    expect(
      getVoiceRecordingBlockReason() === null
      || ['insecure', 'no-mediadevices', 'no-mediarecorder'].includes(
        getVoiceRecordingBlockReason() as string,
      ),
    ).toBe(true)
  })

  it('flags insecure context even when APIs exist', () => {
    vi.stubGlobal('window', {
      isSecureContext: false,
    })
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn() },
    })
    vi.stubGlobal('MediaRecorder', class {})
    expect(getVoiceRecordingBlockReason()).toBe('insecure')
    expect(isVoiceRecordingSupported()).toBe(false)
  })

  it('flags missing MediaRecorder on an otherwise secure page', () => {
    vi.stubGlobal('window', {
      isSecureContext: true,
    })
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn() },
    })
    vi.stubGlobal('MediaRecorder', undefined)
    expect(getVoiceRecordingBlockReason()).toBe('no-mediarecorder')
  })

  it('flags missing mediaDevices', () => {
    vi.stubGlobal('window', {
      isSecureContext: true,
    })
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('MediaRecorder', class {})
    expect(getVoiceRecordingBlockReason()).toBe('no-mediadevices')
  })
})

describe('getUserMediaAudio constraint fallback', () => {
  it('retries with looser constraints on Invalid constraint', async () => {
    const stream = { id: 'ok' } as unknown as MediaStream
    const calls: unknown[] = []
    const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
      calls.push(c)
      const audio = c.audio
      if (audio && typeof audio === 'object' && 'channelCount' in audio) {
        throw Object.assign(new Error('Invalid constraint'), { name: 'OverconstrainedError' })
      }
      return stream
    })
    const got = await getUserMediaAudio(getUserMedia)
    expect(got).toBe(stream)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[0]).toMatchObject({ audio: { channelCount: 1 } })
  })

  it('falls through to audio:true when all advanced constraints fail', async () => {
    const stream = { id: 'bare' } as unknown as MediaStream
    let n = 0
    const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
      n += 1
      if (c.audio !== true) {
        throw Object.assign(new Error('Invalid constraint'), { name: 'OverconstrainedError' })
      }
      return stream
    })
    const got = await getUserMediaAudio(getUserMedia)
    expect(got).toBe(stream)
    expect(n).toBe(4)
    expect(getUserMedia.mock.calls.at(-1)?.[0]).toEqual({ audio: true, video: false })
  })

  it('does not retry permission denials', async () => {
    const getUserMedia = vi.fn(async () => {
      throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    })
    await expect(getUserMediaAudio(getUserMedia)).rejects.toMatchObject({
      name: 'NotAllowedError',
    })
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })
})
