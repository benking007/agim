// v1.2.42 / v1.2.43 — picker + default-remote behaviour.

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  resolveViewerMode, getViewerConfig, getEffectiveRemotePasteUrl,
  DEFAULT_REMOTE_PASTE_URL,
  isViewerApplicablePlatform, isViewerEnabledForPlatform,
} from './viewer-config.js'

const KEYS = [
  'AGIM_VIEWER_ENABLED',
  'AGIM_VIEWER_PUBLIC_BASE_URL',
  'AGIM_VIEWER_TUNNEL_MODE',
  'AGIM_VIEWER_REMOTE_PASTE_URL',
  'AGIM_VIEWER_REMOTE_PASTE_TOKEN',
  'AGIM_VIEWER_NO_DEFAULT_REMOTE',
] as const

function reset() {
  for (const k of KEYS) delete process.env[k]
}

describe('isViewerApplicablePlatform / isViewerEnabledForPlatform', () => {
  beforeEach(reset)

  it('applies to IM messengers, not web/tui/memory jobs', () => {
    expect(isViewerApplicablePlatform('wechat')).toBe(true)
    expect(isViewerApplicablePlatform('wechat-ilink')).toBe(true)
    expect(isViewerApplicablePlatform('telegram')).toBe(true)
    expect(isViewerApplicablePlatform('feishu')).toBe(true)
    expect(isViewerApplicablePlatform('dingtalk')).toBe(true)
    expect(isViewerApplicablePlatform('discord')).toBe(true)
    expect(isViewerApplicablePlatform('email')).toBe(true)
    expect(isViewerApplicablePlatform('web')).toBe(false)
    expect(isViewerApplicablePlatform('tui')).toBe(false)
    expect(isViewerApplicablePlatform('memory-distill')).toBe(false)
    expect(isViewerApplicablePlatform('')).toBe(false)
  })

  it('requires both env ON and an IM platform', () => {
    process.env.AGIM_VIEWER_ENABLED = '1'
    expect(isViewerEnabledForPlatform('wechat')).toBe(true)
    expect(isViewerEnabledForPlatform('web')).toBe(false)
    process.env.AGIM_VIEWER_ENABLED = '0'
    expect(isViewerEnabledForPlatform('wechat')).toBe(false)
  })
})

describe('resolveViewerMode — picker preference order', () => {
  beforeEach(reset)

  it('returns "none" when viewer is disabled', () => {
    expect(resolveViewerMode(getViewerConfig())).toBe('none')
  })

  it('returns "remote" (default community paste) when enabled with no other config', () => {
    process.env.AGIM_VIEWER_ENABLED = '1'
    expect(resolveViewerMode(getViewerConfig())).toBe('remote')
    expect(getEffectiveRemotePasteUrl()).toBe(DEFAULT_REMOTE_PASTE_URL)
  })

  it('returns "none" when default remote is disabled and nothing else configured', () => {
    process.env.AGIM_VIEWER_ENABLED = '1'
    process.env.AGIM_VIEWER_NO_DEFAULT_REMOTE = '1'
    expect(resolveViewerMode(getViewerConfig())).toBe('none')
  })

  it('Public base URL beats every other mode (v1.2.45 picker)', () => {
    process.env.AGIM_VIEWER_ENABLED = '1'
    process.env.AGIM_VIEWER_PUBLIC_BASE_URL = 'https://my.host'
    process.env.AGIM_VIEWER_TUNNEL_MODE = 'quick'
    process.env.AGIM_VIEWER_REMOTE_PASTE_URL = 'https://paste.example/paste'
    expect(resolveViewerMode(getViewerConfig())).toBe('local')
  })

  it('user-set REMOTE_PASTE_URL only takes effect when public / tunnel are empty', () => {
    process.env.AGIM_VIEWER_ENABLED = '1'
    process.env.AGIM_VIEWER_REMOTE_PASTE_URL = 'https://paste.example/paste'
    expect(resolveViewerMode(getViewerConfig())).toBe('remote')
    expect(getEffectiveRemotePasteUrl()).toBe('https://paste.example/paste')
  })

  it('"local" picked when only PUBLIC_BASE_URL is set (no remote override)', () => {
    process.env.AGIM_VIEWER_ENABLED = '1'
    process.env.AGIM_VIEWER_PUBLIC_BASE_URL = 'https://my.host'
    expect(resolveViewerMode(getViewerConfig())).toBe('local')
  })

  it('"tunnel" picked when only TUNNEL_MODE=quick is set', () => {
    process.env.AGIM_VIEWER_ENABLED = '1'
    process.env.AGIM_VIEWER_TUNNEL_MODE = 'quick'
    expect(resolveViewerMode(getViewerConfig())).toBe('tunnel')
  })

  it('local wins over tunnel when both set (still no remote)', () => {
    process.env.AGIM_VIEWER_ENABLED = '1'
    process.env.AGIM_VIEWER_PUBLIC_BASE_URL = 'https://my.host'
    process.env.AGIM_VIEWER_TUNNEL_MODE = 'quick'
    expect(resolveViewerMode(getViewerConfig())).toBe('local')
  })

  it('empty REMOTE_PASTE_URL is treated as not configured (falls back to local)', () => {
    process.env.AGIM_VIEWER_ENABLED = '1'
    process.env.AGIM_VIEWER_PUBLIC_BASE_URL = 'https://my.host'
    process.env.AGIM_VIEWER_REMOTE_PASTE_URL = ''
    expect(resolveViewerMode(getViewerConfig())).toBe('local')
  })

  it('remotePasteToken is captured into the config when set', () => {
    process.env.AGIM_VIEWER_ENABLED = '1'
    process.env.AGIM_VIEWER_REMOTE_PASTE_URL = 'https://paste.example/paste'
    process.env.AGIM_VIEWER_REMOTE_PASTE_TOKEN = 'secret-bearer-xyz'
    const cfg = getViewerConfig()
    expect(cfg.remotePasteUrl).toBe('https://paste.example/paste')
    expect(cfg.remotePasteToken).toBe('secret-bearer-xyz')
  })

  it('default-remote is skipped when local is configured', () => {
    process.env.AGIM_VIEWER_ENABLED = '1'
    process.env.AGIM_VIEWER_PUBLIC_BASE_URL = 'https://my.host'
    expect(getEffectiveRemotePasteUrl()).toBe(DEFAULT_REMOTE_PASTE_URL) // helper returns the default
    expect(resolveViewerMode(getViewerConfig())).toBe('local')          // but picker still picks local
  })
})
