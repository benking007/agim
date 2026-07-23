import { describe, expect, it } from 'bun:test'
import { extensionForAudioMime, CHAT_TRANSCRIBE_MAX_BYTES } from '../../src/core/chat-transcribe.js'

describe('chat-transcribe helpers', () => {
  it('picks extensions from mime and filename', () => {
    expect(extensionForAudioMime('audio/webm;codecs=opus')).toBe('.webm')
    expect(extensionForAudioMime('audio/mp4')).toBe('.m4a')
    expect(extensionForAudioMime('application/octet-stream', 'clip.m4a')).toBe('.m4a')
    expect(extensionForAudioMime('')).toBe('.webm')
  })

  it('exposes a sane upload cap', () => {
    expect(CHAT_TRANSCRIBE_MAX_BYTES).toBeGreaterThan(1_000_000)
  })
})
