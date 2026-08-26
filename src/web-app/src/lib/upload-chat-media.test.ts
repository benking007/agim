import { describe, expect, it } from 'vitest'
import { formatUploadError } from './upload-chat-media'

describe('formatUploadError', () => {
  it('maps Cloudflare 524 HTML to a user-facing timeout', () => {
    const msg = formatUploadError(524, '<html>Cloudflare 524: A timeout occurred</html>')
    expect(msg).toMatch(/524|超时|timeout/i)
  })

  it('maps 504 to the timeout copy', () => {
    expect(formatUploadError(504, '')).toMatch(/超时|timed out/i)
  })

  it('strips HTML from other errors', () => {
    expect(formatUploadError(500, '<p>boom</p>')).toBe('boom')
  })
})
