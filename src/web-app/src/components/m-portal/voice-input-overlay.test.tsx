import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VoiceInputOverlay } from './voice-input-overlay'

describe('VoiceInputOverlay', () => {
  it('shows listening hint', () => {
    render(<VoiceInputOverlay phase="listening" level={0.4} />)
    expect(screen.getByText(/我在听|Listening/i)).toBeTruthy()
  })

  it('shows cancel hint', () => {
    render(<VoiceInputOverlay phase="cancel" level={0.2} />)
    expect(screen.getByText(/松开取消|Release to cancel/i)).toBeTruthy()
  })

  it('shows transcribing hint', () => {
    render(<VoiceInputOverlay phase="transcribing" />)
    expect(screen.getByText(/正在识别|Transcribing/i)).toBeTruthy()
  })
})
