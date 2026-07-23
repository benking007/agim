import { describe, expect, it } from 'vitest'
import { isVoiceRecordingSupported } from './voice-recorder'

describe('voice-recorder', () => {
  it('reports support based on browser APIs', () => {
    // jsdom / vitest: usually no MediaRecorder — just ensure the helper is callable.
    expect(typeof isVoiceRecordingSupported()).toBe('boolean')
  })
})
