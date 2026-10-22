// OAuth 2.1 authorization code + PKCE S256 for the MCP resource.
//
// Discovery follows protected-resource metadata and authorization-server
// metadata. ChatGPT is a public client (token endpoint auth "none")
// identified by its client metadata document. redirect_uri must also be
// on the admin allowlist. Bridge tokens are not access tokens.
// Subscription delivery URLs are not stored here.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import https from 'node:https'
import { dirname, join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { validateBridgeCallbackUrl } from './bridge-peers.js'

export const MCP_HTTP_PATH = '/api/bridge/mcp'
export const OAUTH_SCOPE = 'mcp'
export const PROTECTED_RESOURCE_PATH = `/.well-known/oauth-protected-resource${MCP_HTTP_PATH}`
export const AUTHORIZATION_SERVER_PATH = '/.well-known/oauth-authorization-server'
export const AUTHORIZE_PATH = '/bridge/oauth/authorize'
export const TOKEN_PATH = '/api/bridge/oauth/token'

const CODE_TTL_MS = 60_000
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000
const MAX_REDIRECTS = 32
const CHALLENGE = /^[A-Za-z0-9._~-]{43,128}$/
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/

interface StoredCode {
  hash: string
  challenge: string
  redirectUri: string
  clientId: string
  resource: string
  scope: string
  subject: string
  expiresAt: number
}

interface StoredToken {
  hash: string
  resource: string
  scope: string
  subject: string
  clientId: string
  expiresAt: number
}

interface OauthFile {
  redirectUris: string[]
  codes: StoredCode[]
  tokens: StoredToken[]
}

export interface AuthorizeInput {
  responseType: string
  clientId: string
  redirectUri: string
  codeChallenge: string
  codeChallengeMethod: string
  resource: string
  scope: string
  state: string
}

export type OauthFailure = { ok: false; status: number; error: string; description: string }
export type AuthorizeOk = {
  ok: true
  scope: string
  resource: string
  issuer: string
  redirectUri: string
}

let tail: Promise<void> = Promise.resolve()
let metadataFetcher: ((url: string) => Promise<Record<string, unknown> | null>) | null = null

function homeDir(): string {
  return process.env.AGIM_HOME || AGIM_HOME
}

function filePath(): string {
  return join(homeDir(), 'bridge-mcp-oauth.json')
}

function emptyFile(): OauthFile {
  return { redirectUris: [], codes: [], tokens: [] }
}

function readOauthFile(): OauthFile {
  const path = filePath()
  if (!existsSync(path)) return emptyFile()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<OauthFile>
    return {
      redirectUris: Array.isArray(parsed.redirectUris)
        ? parsed.redirectUris.filter((item): item is string => typeof item === 'string')
        : [],
      codes: Array.isArray(parsed.codes) ? parsed.codes as StoredCode[] : [],
      tokens: Array.isArray(parsed.tokens) ? parsed.tokens as StoredToken[] : [],
    }
  } catch {
    return emptyFile()
  }
}

function writeOauthFile(file: OauthFile): void {
  const path = filePath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(file)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    try { unlinkSync(tmp) } catch { /* ignore */ }
    throw err
  }
  try { chmodSync(path, 0o600) } catch { /* ignore non-POSIX */ }
}

function prune(file: OauthFile, now = Date.now()): void {
  file.codes = file.codes.filter((row) => row.expiresAt > now)
  file.tokens = file.tokens.filter((row) => row.expiresAt > now)
}

async function mutate<T>(fn: (file: OauthFile) => T): Promise<T> {
  const run = tail.then(() => {
    const file = readOauthFile()
    prune(file)
    const result = fn(file)
    writeOauthFile(file)
    return result
  })
  tail = run.then(() => undefined, () => undefined)
  return run
}

function hashSecret(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function findByHash<T extends { hash: string }>(rows: T[], raw: string): T | null {
  const want = Buffer.from(hashSecret(raw))
  let found: T | null = null
  for (const row of rows) {
    const have = Buffer.from(row.hash)
    if (have.length === want.length && timingSafeEqual(have, want)) found = row
  }
  return found
}

export function originOf(base: string): string {
  return base.replace(/\/+$/, '')
}

export function mcpResourceIdentifier(origin: string): string {
  return `${originOf(origin)}${MCP_HTTP_PATH}`
}

export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  const issuer = originOf(origin)
  return {
    resource: mcpResourceIdentifier(issuer),
    authorization_servers: [issuer],
    scopes_supported: [OAUTH_SCOPE],
    bearer_methods_supported: ['header'],
  }
}

export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  const issuer = originOf(origin)
  return {
    issuer,
    authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${TOKEN_PATH}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: [OAUTH_SCOPE],
  }
}

export function pkceS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

export function listOauthRedirectUris(): string[] {
  return [...readOauthFile().redirectUris]
}

export function acceptableRedirectUri(raw: string): string | null {
  const value = raw.trim()
  if (!value || value.length > 2048) return null
  let url: URL
  try { url = new URL(value) } catch { return null }
  if (url.protocol !== 'https:') return null
  if (url.username || url.password || url.hash) return null
  return value
}

export async function addOauthRedirectUri(raw: string): Promise<{ ok: true; redirectUris: string[] } | { ok: false; error: string }> {
  const uri = acceptableRedirectUri(raw)
  if (!uri) return { ok: false, error: 'redirect URI must be an https URL without a fragment' }
  return mutate((file) => {
    if (!file.redirectUris.includes(uri)) {
      if (file.redirectUris.length >= MAX_REDIRECTS) return { ok: false as const, error: 'too many redirect URIs' }
      file.redirectUris.push(uri)
    }
    return { ok: true as const, redirectUris: [...file.redirectUris] }
  })
}

export async function removeOauthRedirectUri(raw: string): Promise<string[]> {
  const uri = raw.trim()
  return mutate((file) => {
    file.redirectUris = file.redirectUris.filter((item) => item !== uri)
    return [...file.redirectUris]
  })
}

function fail(status: number, error: string, description: string): OauthFailure {
  return { ok: false, status, error, description }
}

function authMethods(doc: Record<string, unknown>): string[] {
  const plural = doc.token_endpoint_auth_methods_supported
  if (Array.isArray(plural)) return plural.filter((item): item is string => typeof item === 'string')
  if (typeof doc.token_endpoint_auth_method === 'string') return [doc.token_endpoint_auth_method]
  return []
}

function fetchClientMetadata(url: string): Promise<Record<string, unknown> | null> {
  if (metadataFetcher) return metadataFetcher(url)
  return new Promise((resolve) => {
    const req = https.request(url, {
      method: 'GET',
      timeout: 5000,
      headers: { accept: 'application/json' },
    }, (res) => {
      const status = res.statusCode ?? 0
      if (status < 200 || status >= 300) {
        res.resume()
        resolve(null)
        return
      }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (chunk: Buffer) => {
        total += chunk.length
        if (total > 65_536) {
          req.destroy()
          resolve(null)
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) resolve(null)
          else resolve(parsed as Record<string, unknown>)
        } catch {
          resolve(null)
        }
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
    req.end()
  })
}

async function clientMetadataAllows(clientId: string, redirectUri: string): Promise<OauthFailure | null> {
  let parsed: URL
  try { parsed = new URL(clientId) } catch {
    return fail(400, 'invalid_client', 'client_id must be an https client metadata document')
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    return fail(400, 'invalid_client', 'client_id must be an https client metadata document')
  }
  // A test can inject the document. Production always requires a public HTTPS URL.
  if (!metadataFetcher) {
    const allowed = await validateBridgeCallbackUrl(clientId, null)
    if (!allowed.ok) return fail(400, 'invalid_client', 'client metadata document is not a public https URL')
  }
  const doc = await fetchClientMetadata(clientId)
  if (!doc) return fail(400, 'invalid_client', 'client metadata document could not be read')
  if (typeof doc.client_id === 'string' && doc.client_id !== clientId) {
    return fail(400, 'invalid_client', 'client metadata document client_id does not match')
  }
  const redirects = Array.isArray(doc.redirect_uris)
    ? doc.redirect_uris.filter((item): item is string => typeof item === 'string')
    : []
  if (!redirects.includes(redirectUri)) {
    return fail(400, 'invalid_request', 'redirect_uri is not in the client metadata document')
  }
  const methods = authMethods(doc)
  if (!methods.includes('none')) {
    return fail(400, 'invalid_client', 'client does not support public token exchange')
  }
  return null
}

/** Reject anything that is not authorization-code + S256, then the allowlist. */
export async function evaluateAuthorize(input: AuthorizeInput, origin: string | null): Promise<OauthFailure | AuthorizeOk> {
  if (input.responseType !== 'code') return fail(400, 'invalid_request', 'response_type must be code')
  if (input.codeChallengeMethod !== 'S256') {
    return fail(400, 'invalid_request', 'code_challenge_method must be S256')
  }
  if (!CHALLENGE.test(input.codeChallenge)) return fail(400, 'invalid_request', 'code_challenge is required')
  const redirectUri = acceptableRedirectUri(input.redirectUri)
  if (!redirectUri || !readOauthFile().redirectUris.includes(redirectUri)) {
    return fail(400, 'invalid_request', 'redirect_uri is not allowed')
  }
  if (!input.clientId || input.clientId.length > 2048) {
    return fail(400, 'invalid_client', 'client_id must be an https client metadata document')
  }
  const clientError = await clientMetadataAllows(input.clientId, redirectUri)
  if (clientError) return clientError
  if (!origin) return fail(503, 'server_error', 'public origin is not configured')
  const resource = mcpResourceIdentifier(origin)
  if (input.resource !== resource) return fail(400, 'invalid_target', 'resource must be the MCP URL')
  const requested = input.scope.split(/ +/).filter(Boolean)
  if (requested.some((scope) => scope !== OAUTH_SCOPE)) {
    return fail(400, 'invalid_scope', 'scope must be mcp')
  }
  if (input.state.length > 512) return fail(400, 'invalid_request', 'state is too long')
  return {
    ok: true,
    scope: requested.length ? requested.join(' ') : OAUTH_SCOPE,
    resource,
    issuer: originOf(origin),
    redirectUri,
  }
}

export async function issueAuthorizationCode(input: {
  challenge: string
  redirectUri: string
  clientId: string
  resource: string
  scope: string
  subject: string
}): Promise<string | null> {
  const subject = input.subject.trim()
  if (!subject || subject.length > 128) return null
  return mutate((file) => {
    if (!file.redirectUris.includes(input.redirectUri)) return null
    const raw = randomBytes(32).toString('base64url')
    file.codes.push({
      hash: hashSecret(raw),
      challenge: input.challenge,
      redirectUri: input.redirectUri,
      clientId: input.clientId,
      resource: input.resource,
      scope: input.scope,
      subject,
      expiresAt: Date.now() + CODE_TTL_MS,
    })
    return raw
  })
}

export interface TokenRequest {
  grantType: string
  code: string
  redirectUri: string
  clientId: string
  codeVerifier: string
  resource: string
  clientSecret: string
  clientAssertion: string
}

export async function exchangeAuthorizationCode(input: TokenRequest): Promise<
  OauthFailure | { ok: true; accessToken: string; expiresIn: number; scope: string }
> {
  if (input.clientSecret || input.clientAssertion) {
    return fail(401, 'invalid_client', 'token endpoint authentication method is none')
  }
  if (input.grantType !== 'authorization_code') {
    return fail(400, 'unsupported_grant_type', 'grant_type must be authorization_code')
  }
  if (!VERIFIER.test(input.codeVerifier)) return fail(400, 'invalid_grant', 'code_verifier is invalid')
  return mutate((file) => {
    const row = input.code ? findByHash(file.codes, input.code) : null
    if (!row || row.expiresAt <= Date.now()) return fail(400, 'invalid_grant', 'authorization code is invalid')
    if (row.redirectUri !== input.redirectUri || row.clientId !== input.clientId || row.resource !== input.resource) {
      return fail(400, 'invalid_grant', 'authorization code is invalid')
    }
    if (!file.redirectUris.includes(row.redirectUri)) return fail(400, 'invalid_grant', 'redirect_uri is not allowed')
    file.codes = file.codes.filter((item) => item.hash !== row.hash)
    if (pkceS256(input.codeVerifier) !== row.challenge) return fail(400, 'invalid_grant', 'code_verifier is invalid')
    const accessToken = `agmcp_${randomBytes(32).toString('base64url')}`
    file.tokens.push({
      hash: hashSecret(accessToken),
      resource: row.resource,
      scope: row.scope,
      subject: row.subject,
      clientId: row.clientId,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    })
    return { ok: true as const, accessToken, expiresIn: Math.floor(TOKEN_TTL_MS / 1000), scope: row.scope }
  })
}

/** Bridge tokens (agim_…) are never access tokens. */
export function readAccessToken(raw: string, resource: string): { subject: string; scope: string } | null {
  if (!raw || raw.startsWith('agim_') || !resource) return null
  const file = readOauthFile()
  const row = findByHash(file.tokens, raw)
  if (!row || row.expiresAt <= Date.now()) return null
  if (row.resource !== resource) return null
  return { subject: row.subject, scope: row.scope }
}

/** Test hook. Production fetches the client metadata document over HTTPS. */
export function setOauthMetadataFetcherForTests(
  fn: ((url: string) => Promise<Record<string, unknown> | null>) | null,
): void {
  metadataFetcher = fn
}
