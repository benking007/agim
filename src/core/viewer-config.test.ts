// v1.2.42 — sanity tests for the three-mode picker.

import { describe, it, expect, beforeEach } from 'bun:test'
import { resolveViewerMode, getViewerConfig } from './viewer-config.js'

const KEYS = [
  'IMHUB_VIEWER_ENABLED',
  'IMHUB_VIEWER_PUBLIC_BASE_URL',
  'IMHUB_VIEWER_TUNNEL_MODE',
  'IMHUB_VIEWER_REMOTE_PASTE_URL',
  'IMHUB_VIEWER_REMOTE_PASTE_TOKEN',
] as const

function reset() {
  for (const k of KEYS) delete process.env[k]
}

describe('resolveViewerMode — picker preference order', () => {
  beforeEach(reset)

  it('returns "none" when viewer is disabled', () => {
    expect(resolveViewerMode(getViewerConfig())).toBe('none')
  })

  it('returns "none" when enabled but no public URL / tunnel / remote configured', () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    expect(resolveViewerMode(getViewerConfig())).toBe('none')
  })

  it('"remote" wins when REMOTE_PASTE_URL is set (even with other modes also set)', () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    process.env.IMHUB_VIEWER_PUBLIC_BASE_URL = 'https://my.host'
    process.env.IMHUB_VIEWER_TUNNEL_MODE = 'quick'
    process.env.IMHUB_VIEWER_REMOTE_PASTE_URL = 'https://paste.example/paste'
    expect(resolveViewerMode(getViewerConfig())).toBe('remote')
  })

  it('"local" picked when only PUBLIC_BASE_URL is set', () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    process.env.IMHUB_VIEWER_PUBLIC_BASE_URL = 'https://my.host'
    expect(resolveViewerMode(getViewerConfig())).toBe('local')
  })

  it('"tunnel" picked when only TUNNEL_MODE=quick is set', () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    process.env.IMHUB_VIEWER_TUNNEL_MODE = 'quick'
    expect(resolveViewerMode(getViewerConfig())).toBe('tunnel')
  })

  it('local wins over tunnel when both set', () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    process.env.IMHUB_VIEWER_PUBLIC_BASE_URL = 'https://my.host'
    process.env.IMHUB_VIEWER_TUNNEL_MODE = 'quick'
    expect(resolveViewerMode(getViewerConfig())).toBe('local')
  })

  it('empty REMOTE_PASTE_URL is treated as not configured (falls back to local)', () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    process.env.IMHUB_VIEWER_PUBLIC_BASE_URL = 'https://my.host'
    process.env.IMHUB_VIEWER_REMOTE_PASTE_URL = ''
    expect(resolveViewerMode(getViewerConfig())).toBe('local')
  })

  it('remotePasteToken is captured into the config when set', () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    process.env.IMHUB_VIEWER_REMOTE_PASTE_URL = 'https://paste.example/paste'
    process.env.IMHUB_VIEWER_REMOTE_PASTE_TOKEN = 'secret-bearer-xyz'
    const cfg = getViewerConfig()
    expect(cfg.remotePasteUrl).toBe('https://paste.example/paste')
    expect(cfg.remotePasteToken).toBe('secret-bearer-xyz')
  })
})
