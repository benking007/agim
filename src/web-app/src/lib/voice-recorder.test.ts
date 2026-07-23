import { afterEach, describe, expect, it, vi } from 'vitest'
import {
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
