// v1.2.42 / v1.2.43 — picker + default-remote behaviour.

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  resolveViewerMode, getViewerConfig, getEffectiveRemotePasteUrl,
  DEFAULT_REMOTE_PASTE_URL,
} from './viewer-config.js'

const KEYS = [
  'IMHUB_VIEWER_ENABLED',
  'IMHUB_VIEWER_PUBLIC_BASE_URL',
  'IMHUB_VIEWER_TUNNEL_MODE',
  'IMHUB_VIEWER_REMOTE_PASTE_URL',
  'IMHUB_VIEWER_REMOTE_PASTE_TOKEN',
  'IMHUB_VIEWER_NO_DEFAULT_REMOTE',
] as const

function reset() {
  for (const k of KEYS) delete process.env[k]
}

describe('resolveViewerMode — picker preference order', () => {
  beforeEach(reset)

  it('returns "none" when viewer is disabled', () => {
    expect(resolveViewerMode(getViewerConfig())).toBe('none')
  })

  it('returns "remote" (default community paste) when enabled with no other config', () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    expect(resolveViewerMode(getViewerConfig())).toBe('remote')
    expect(getEffectiveRemotePasteUrl()).toBe(DEFAULT_REMOTE_PASTE_URL)
  })

  it('returns "none" when default remote is disabled and nothing else configured', () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    process.env.IMHUB_VIEWER_NO_DEFAULT_REMOTE = '1'
    expect(resolveViewerMode(getViewerConfig())).toBe('none')
  })

  it('"remote" wins when user sets REMOTE_PASTE_URL (overrides default and other modes)', () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    process.env.IMHUB_VIEWER_PUBLIC_BASE_URL = 'https://my.host'
    process.env.IMHUB_VIEWER_TUNNEL_MODE = 'quick'
    process.env.IMHUB_VIEWER_REMOTE_PASTE_URL = 'https://paste.example/paste'
    expect(resolveViewerMode(getViewerConfig())).toBe('remote')
    expect(getEffectiveRemotePasteUrl()).toBe('https://paste.example/paste')
  })

  it('"local" picked when only PUBLIC_BASE_URL is set (no remote override)', () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    process.env.IMHUB_VIEWER_PUBLIC_BASE_URL = 'https://my.host'
    expect(resolveViewerMode(getViewerConfig())).toBe('local')
  })

  it('"tunnel" picked when only TUNNEL_MODE=quick is set', () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    process.env.IMHUB_VIEWER_TUNNEL_MODE = 'quick'
    expect(resolveViewerMode(getViewerConfig())).toBe('tunnel')
  })

  it('local wins over tunnel when both set (still no remote)', () => {
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

  it('default-remote is skipped when local is configured', () => {
    process.env.IMHUB_VIEWER_ENABLED = '1'
    process.env.IMHUB_VIEWER_PUBLIC_BASE_URL = 'https://my.host'
    expect(getEffectiveRemotePasteUrl()).toBe(DEFAULT_REMOTE_PASTE_URL) // helper returns the default
    expect(resolveViewerMode(getViewerConfig())).toBe('local')          // but picker still picks local
  })
})
