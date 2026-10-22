/**
 * MCP OAuth discovery and the checks that must fail closed.
 * The bridge token is not an access token. Delivery is not exercised here.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'

const home = mkdtempSync(join(tmpdir(), 'agim-mcp-oauth-'))
const previousHome = process.env.AGIM_HOME
process.env.AGIM_HOME = home
process.env.AGIM_WEB_AUTH = 'on'
process.env.LOG_LEVEL = 'silent'
delete process.env.AGIM_VIEWER_PUBLIC_BASE_URL

const oauth = await import('../../src/core/bridge-mcp-oauth.js')
const http = await import('../../src/web/bridge-mcp-oauth-http.js')
const auth = await import('../../src/web/auth.js')

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.AGIM_HOME
  else process.env.AGIM_HOME = previousHome
})

function mockRes(): ServerResponse & { statusCode: number; body: string; headers: Record<string, string | number | string[] | undefined> } {
  const headers: Record<string, string | number | string[] | undefined> = {}
  const res = {
    statusCode: 0,
    body: '',
    headers,
    writeHead(code: number, extra?: Record<string, string | number | string[]>) {
      res.statusCode = code
      if (extra) Object.assign(headers, extra)
      return res
    },
    end(payload?: string) {
      res.body = payload ?? ''
    },
  }
  return res as unknown as ServerResponse & { statusCode: number; body: string; headers: typeof headers }
}

function mockReq(method: string, path: string, headers: Record<string, string> = {}, body = ''): IncomingMessage {
  const req = {
    method,
    url: path,
    headers: { host: 'dev.myfund.work', ...headers },
    socket: { remoteAddress: '203.0.113.10', encrypted: true },
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data' && body) cb(Buffer.from(body))
      if (event === 'end') cb()
      return req
    },
  }
  return req as unknown as IncomingMessage
}

describe('MCP OAuth', () => {
  it('publishes protected-resource and authorization-server metadata', async () => {
    const protectedRes = mockRes()
    const protectedUrl = new URL('https://dev.myfund.work/.well-known/oauth-protected-resource/api/bridge/mcp')
    const protectedHandled = await http.handleBridgeOauthHttp(
      mockReq('GET', protectedUrl.pathname),
      protectedRes,
      protectedUrl,
    )
    expect(protectedHandled).toBe(true)
    expect(protectedRes.statusCode).toBe(200)
    const resource = JSON.parse(protectedRes.body) as {
      resource: string
      authorization_servers: string[]
      scopes_supported: string[]
    }
    expect(resource.resource).toBe('https://dev.myfund.work/api/bridge/mcp')
    expect(resource.authorization_servers).toEqual(['https://dev.myfund.work'])
    expect(resource.scopes_supported).toContain('mcp')

    const authRes = mockRes()
    const authUrl = new URL('https://dev.myfund.work/.well-known/oauth-authorization-server')
    const authHandled = await http.handleBridgeOauthHttp(mockReq('GET', authUrl.pathname), authRes, authUrl)
    expect(authHandled).toBe(true)
    const metadata = JSON.parse(authRes.body) as {
      issuer: string
      authorization_endpoint: string
      token_endpoint: string
      code_challenge_methods_supported: string[]
      token_endpoint_auth_methods_supported: string[]
      client_id_metadata_document_supported: boolean
      authorization_response_iss_parameter_supported: boolean
    }
    expect(metadata.issuer).toBe('https://dev.myfund.work')
    expect(metadata.authorization_endpoint).toBe('https://dev.myfund.work/bridge/oauth/authorize')
    expect(metadata.token_endpoint).toBe('https://dev.myfund.work/api/bridge/oauth/token')
    expect(metadata.code_challenge_methods_supported).toContain('S256')
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none'])
    expect(metadata.client_id_metadata_document_supported).toBe(true)
    expect(metadata.authorization_response_iss_parameter_supported).toBe(true)
    expect(auth.isPublicPath('/.well-known/oauth-protected-resource/api/bridge/mcp', 'GET')).toBe(true)
    expect(auth.isPublicPath('/.well-known/oauth-authorization-server', 'GET')).toBe(true)
    expect(auth.isPublicPath('/api/bridge/oauth/token', 'POST')).toBe(true)
    expect(auth.isPublicPath('/api/bridge/runs', 'POST')).toBe(false)
    const spa = await import('../../src/web/spa-fallback.js')
    expect(spa.shouldServeSpaIndex('/bridge/oauth/authorize')).toBe(false)
    expect(spa.shouldServeSpaIndex('/settings/advanced/bridge')).toBe(true)
    const authorizeUrl = new URL('https://dev.myfund.work/bridge/oauth/authorize?response_type=code')
    const authorizeRes = mockRes()
    const authorizeHandled = await http.handleBridgeOauthHttp(
      mockReq('GET', `${authorizeUrl.pathname}${authorizeUrl.search}`),
      authorizeRes,
      authorizeUrl,
    )
    expect(authorizeHandled).toBe(true)
    expect(authorizeRes.statusCode).not.toBe(404)
    expect(authorizeRes.body.includes('什么也没找到')).toBe(false)
  })

  it('rejects authorization without PKCE S256', async () => {
    await oauth.addOauthRedirectUri('https://chatgpt.com/connector_platform_oauth_redirect')
    const url = new URL('https://dev.myfund.work/bridge/oauth/authorize')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', 'https://chatgpt.com/oauth/client.json')
    url.searchParams.set('redirect_uri', 'https://chatgpt.com/connector_platform_oauth_redirect')
    url.searchParams.set('code_challenge', 'a'.repeat(43))
    url.searchParams.set('code_challenge_method', 'plain')
    url.searchParams.set('resource', 'https://dev.myfund.work/api/bridge/mcp')
    const res = mockRes()
    const handled = await http.handleBridgeOauthHttp(mockReq('GET', `${url.pathname}${url.search}`), res, url)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { error: string; error_description: string }
    expect(body.error).toBe('invalid_request')
    expect(body.error_description).toContain('S256')
    expect(res.headers.Location).toBeUndefined()
  })

  it('rejects a redirect_uri that is not on the allowlist', async () => {
    const url = new URL('https://dev.myfund.work/bridge/oauth/authorize')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', 'https://chatgpt.com/oauth/client.json')
    url.searchParams.set('redirect_uri', 'https://evil.example/callback')
    url.searchParams.set('code_challenge', 'a'.repeat(43))
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('resource', 'https://dev.myfund.work/api/bridge/mcp')
    const res = mockRes()
    const handled = await http.handleBridgeOauthHttp(mockReq('GET', `${url.pathname}${url.search}`), res, url)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    const body = JSON.parse(res.body) as { error: string; error_description: string }
    expect(body.error).toBe('invalid_request')
    expect(body.error_description).toContain('redirect_uri')
    expect(res.headers.Location).toBeUndefined()
  })

  it('does not call MCP tools without an access token', async () => {
    const url = new URL('https://dev.myfund.work/api/bridge/mcp')
    const res = mockRes()
    const handled = await http.handleBridgeOauthHttp(
      mockReq('POST', url.pathname, {
        'content-type': 'application/json',
      }),
      res,
      url,
    )
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body).code).toBe('MCP_OAUTH_REQUIRED')
    const challenge = String(res.headers['WWW-Authenticate'] || '')
    expect(challenge).toContain('resource_metadata="https://dev.myfund.work/.well-known/oauth-protected-resource/api/bridge/mcp"')
    expect(challenge).toContain('error="invalid_request"')
    expect(res.body.includes('"result"')).toBe(false)

    const bridge = mockRes()
    const bridgeHandled = await http.handleBridgeOauthHttp(
      mockReq('POST', url.pathname, { authorization: 'Bearer agim_not_a_plugin_login' }),
      bridge,
      url,
    )
    expect(bridgeHandled).toBe(true)
    expect(bridge.statusCode).toBe(401)
    expect(JSON.parse(bridge.body).code).toBe('MCP_OAUTH_REQUIRED')
    expect(String(bridge.headers['WWW-Authenticate'] || '')).toContain('error="invalid_token"')
    expect(auth.isPublicPath('/api/bridge/mcp', 'POST')).toBe(true)
  })

  it('exchanges an S256 code and then accepts the access token', async () => {
    const previous = process.env.AGIM_WEB_AUTH
    process.env.AGIM_WEB_AUTH = 'off'
    const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect'
    const clientId = 'https://chatgpt.com/oauth/client.json'
    oauth.setOauthMetadataFetcherForTests(async () => ({
      client_id: clientId,
      redirect_uris: [redirect],
      token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      token_endpoint_auth_method: 'private_key_jwt',
    }))
    try {
      await oauth.addOauthRedirectUri(redirect)
      const verifier = 'a'.repeat(50)
      const url = new URL('https://dev.myfund.work/bridge/oauth/authorize')
      url.searchParams.set('response_type', 'code')
      url.searchParams.set('client_id', clientId)
      url.searchParams.set('redirect_uri', redirect)
      url.searchParams.set('code_challenge', oauth.pkceS256(verifier))
      url.searchParams.set('code_challenge_method', 'S256')
      url.searchParams.set('resource', 'https://dev.myfund.work/api/bridge/mcp')
      url.searchParams.set('state', 'st')
      const page = mockRes()
      await http.handleBridgeOauthHttp(mockReq('GET', `${url.pathname}${url.search}`), page, url)
      expect(page.statusCode).toBe(200)
      expect(page.body).toContain('允许 ChatGPT 连接 Agim')
      expect(page.body).toContain('name="consent" value="allow">允许')
      expect(page.body).toContain('name="consent" value="deny">拒绝')
      expect(page.body).toContain('overflow-wrap: anywhere')

      const approved = mockRes()
      await http.handleBridgeOauthHttp(
        mockReq('POST', `${url.pathname}${url.search}`, {
          'content-type': 'application/x-www-form-urlencoded',
        }, 'consent=allow'),
        approved,
        url,
      )
      expect(approved.statusCode).toBe(302)
      const loc = new URL(String(approved.headers.Location))
      expect(loc.origin + loc.pathname).toBe(redirect)
      expect(loc.searchParams.get('iss')).toBe('https://dev.myfund.work')
      expect(loc.searchParams.get('state')).toBe('st')
      const code = loc.searchParams.get('code') || ''
      expect(code.length).toBeGreaterThan(20)

      const tokenRes = mockRes()
      const form = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
        client_id: clientId,
        code_verifier: verifier,
        resource: 'https://dev.myfund.work/api/bridge/mcp',
      })
      await http.handleBridgeOauthHttp(
        mockReq('POST', '/api/bridge/oauth/token', {
          'content-type': 'application/x-www-form-urlencoded',
        }, form.toString()),
        tokenRes,
        new URL('https://dev.myfund.work/api/bridge/oauth/token'),
      )
      expect(tokenRes.statusCode).toBe(200)
      const issued = JSON.parse(tokenRes.body) as { access_token: string; token_type: string }
      expect(issued.token_type).toBe('Bearer')
      expect(issued.access_token.startsWith('agim_')).toBe(false)

      const call = mockRes()
      const mcpUrl = new URL('https://dev.myfund.work/api/bridge/mcp')
      await http.handleBridgeOauthHttp(
        mockReq('POST', mcpUrl.pathname, {
          authorization: `Bearer ${issued.access_token}`,
          'content-type': 'application/json',
        }, JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'agim_get_run', arguments: { runId: 'run_x' } },
        })),
        call,
        mcpUrl,
      )
      expect(call.statusCode).toBe(200)
      const rpc = JSON.parse(call.body) as { error?: { message: string }; result?: unknown }
      expect(rpc.result).toBeUndefined()
      expect(rpc.error?.message === 'bridge is off' || rpc.error?.message === 'an enabled MCP Events caller is required').toBe(true)
    } finally {
      oauth.setOauthMetadataFetcherForTests(null)
      if (previous === undefined) delete process.env.AGIM_WEB_AUTH
      else process.env.AGIM_WEB_AUTH = previous
    }
  })
})
