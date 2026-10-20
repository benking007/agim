// Public bridge caller contract and the one-time handoff prompt.
//
// The contract page is the markdown file itself. The prompt only adds the
// secret and the identity for this issuance: token, base URL, and the
// contract URL. Nothing here is stored after the create response.

import { existsSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getEffectivePublicBaseUrl } from '../core/viewer-config.js'
import { isLoopbackPeer } from './auth.js'

export const BRIDGE_CALLER_GUIDE_PATH = '/api/bridge/caller-access'

function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : ''
}

function isPublicHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false
  if (host === '::1' || host.startsWith('127.')) return false
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (parts) {
    const a = Number(parts[1])
    const b = Number(parts[2])
    if ([a, b, Number(parts[3]), Number(parts[4])].some((n) => n > 255)) return false
    if (a === 10 || a === 0 || a === 127) return false
    if (a === 169 && b === 254) return false
    if (a === 172 && b >= 16 && b <= 31) return false
    if (a === 192 && b === 168) return false
    if (a >= 224) return false
    return true
  }
  if (host.includes(':')) return false
  return host.includes('.')
}

/** Origin only. A path on the configured base is not part of the bridge root. */
export function parsePublicBase(raw: string | null | undefined): string | null {
  if (!raw) return null
  let url: URL
  try { url = new URL(raw.trim()) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.username || url.password) return null
  if (!isPublicHostname(url.hostname)) return null
  const port = url.port ? `:${url.port}` : ''
  return `${url.protocol}//${url.hostname}${port}`
}

function originFromHost(proto: 'http' | 'https', hostHeader: string): string | null {
  const host = hostHeader.split(',')[0]?.trim() || ''
  if (!host || /\s/.test(host)) return null
  return parsePublicBase(`${proto}://${host}`)
}

function requestPublicOrigin(req: IncomingMessage): string | null {
  if (isLoopbackPeer(req)) {
    const forwarded = headerValue(req, 'x-forwarded-host')
    if (forwarded) {
      const proto = headerValue(req, 'x-forwarded-proto').split(',')[0]?.trim().toLowerCase()
      return originFromHost(proto === 'http' ? 'http' : 'https', forwarded)
    }
  }
  const host = headerValue(req, 'host')
  if (!host) return null
  const encrypted = (req.socket as { encrypted?: boolean } | undefined)?.encrypted === true
  return originFromHost(encrypted ? 'https' : 'http', host)
}

/**
 * Public origin for this process.
 * Configured viewer base, then the request's public origin, then the
 * base the admin typed for this issuance. Loopback is not reliable.
 */
export function resolveBridgePublicBase(req: IncomingMessage, manual?: string | null): string | null {
  const configured = parsePublicBase(getEffectivePublicBaseUrl())
  if (configured) return configured
  const fromRequest = requestPublicOrigin(req)
  if (fromRequest) return fromRequest
  return parsePublicBase(manual)
}

export function bridgeCallerGuideFile(): string | null {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '../../docs/bridge-caller-access.md'),
    join(here, '../../../docs/bridge-caller-access.md'),
    join(process.cwd(), 'docs/bridge-caller-access.md'),
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}

export function readBridgeCallerGuide(): string | null {
  const path = bridgeCallerGuideFile()
  if (!path) return null
  return readFileSync(path, 'utf8')
}

export function bridgeCallerGuideUrl(base: string): string {
  return `${base.replace(/\/+$/, '')}${BRIDGE_CALLER_GUIDE_PATH}`
}

/** One-time handoff. The contract stays on the public page. */
export function buildBridgeCallerPrompt(rawToken: string, baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  return [
    '【含密钥，只此一次】关闭页面后不能再生成，也不能再查看令牌原文。',
    '按对接页实现，不要等更多说明。对接页没有令牌。',
    '',
    `基址：${base}`,
    `对接页：${bridgeCallerGuideUrl(base)}`,
    `桥接令牌：${rawToken}`,
  ].join('\n')
}

export function serveBridgeCallerGuide(res: ServerResponse): void {
  const body = readBridgeCallerGuide()
  if (body == null) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('caller guide is not available')
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}
