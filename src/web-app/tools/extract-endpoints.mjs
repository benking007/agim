#!/usr/bin/env node
/**
 * Extract REST routes from the web composition root + domain API modules.
 *
 * After the arch split, most exact/dynamic matches live in
 * `src/web/*-api.ts` (and auth helpers), while `server.ts` only prefixes
 * and delegates via `handleXxxApi`. This scanner reads every `src/web/*.ts`
 * source (except tests) and builds tools/endpoints.json.
 *
 * Default mode updates tools/endpoints.json. `--check` compares without writing.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const toolDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(toolDir, '../../..')
const webDir = resolve(root, 'src/web')
const manifestPath = resolve(toolDir, 'endpoints.json')
const checkMode = process.argv.includes('--check')

const publicRoutes = new Set([
  'POST /api/auth/login',
  'POST /api/auth/register',
  'GET /api/auth/captcha',
  'GET /api/auth/bootstrap-state',
  'POST /api/auth/exchange-mobile',
  'GET /api/health',
  'POST /api/loc',
  'GET /api/loc/info',
])

// Regex routes cannot be recovered reliably from arbitrary regular
// expressions. Keeping this map explicit makes additions reviewable.
const dynamicRoutes = {
  jobIdMatch: [['GET', '/api/jobs/:id']],
  jobCancelMatch: [['POST', '/api/jobs/:id/cancel']],
  jobRunMatch: [['POST', '/api/jobs/:id/run']],
  bgjobIdMatch: [['GET', '/api/bgjobs/:id']],
  reminderCancelMatch: [['POST', '/api/reminders/:id/cancel']],
  reminderSnoozeMatch: [['POST', '/api/reminders/:id/snooze']],
  memoIdMatch: [['DELETE', '/api/memos/:id']],
  workspaceIdMatch: [
    ['PATCH', '/api/workspaces/:id'],
    ['DELETE', '/api/workspaces/:id'],
  ],
  outboxRetryMatch: [['POST', '/api/outbox/:id/retry']],
  a2aTreeMatch: [['GET', '/api/a2a/tree/:id']],
  artifactsListMatch: [['GET', '/api/artifacts/:id']],
  artifactsFileMatch: [['GET', '/api/artifacts/:id/file/:name']],
  viewerIdMatch: [
    ['GET', '/api/viewer/:id'],
    ['DELETE', '/api/viewer/:id'],
  ],
  memFactIdMatch: [['DELETE', '/api/memory/facts/:id']],
  skillDetailMatch: [['GET', '/api/skills/:slug']],
  approvalResolveMatch: [['POST', '/api/approvals/:reqId/resolve']],
  removeMatch: [['DELETE', '/api/mcp/servers/:name']],
  healthMatch: [['POST', '/api/mcp/servers/:name/health']],
  loopIdMatch: [['GET', '/api/loops/:id']],
  loopReportMatch: [['GET', '/api/loops/:id/report']],
  tokenMatch: [['DELETE', '/api/me/tokens/:id']],
  userMatch: [['PATCH', '/api/admin/users/:id']],
  invMatch: [['DELETE', '/api/admin/invites/:id']],
  quotaMatch: [['PATCH', '/api/admin/users/:id/points']],
  skillEnabledMatch: [['PATCH', '/api/agim-skills/:name/enabled']],
  scheduleIdMatch: [
    ['PATCH', '/api/schedules/:id'],
    ['DELETE', '/api/schedules/:id'],
  ],
}

const ignoredDynamicMatches = new Set([
  // Public HTML viewer route, not REST.
  'viewerMatch',
])

const exactPatterns = [
  // url.pathname === '/api/x' && req.method === 'GET'
  /if \(url\.pathname === '([^']+)'\s*&&\s*req\.method === '([A-Z]+)'\)/g,
  /if \(req\.method === '([A-Z]+)'\s*&&\s*url\.pathname === '([^']+)'\)/g,
  // Domain dispatchers: p === '/api/x' && m === 'GET'
  /if \(p === '([^']+)'\s*&&\s*m === '([A-Z]+)'\)/g,
  /if \(m === '([A-Z]+)'\s*&&\s*p === '([^']+)'\)/g,
]

function listWebSources() {
  return readdirSync(webDir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
    .map((name) => join(webDir, name))
    .sort()
}

function routeKey(endpoint) {
  return `${endpoint.method} ${endpoint.path}`
}

function addEndpoint(target, seen, method, path, source) {
  if (!path.startsWith('/api/')) return
  const key = `${method} ${path}`
  if (seen.has(key)) return
  seen.add(key)
  target.push({
    method,
    path,
    source,
    authRequired: !publicRoutes.has(key),
  })
}

function extractFromText(sourceText, endpoints, seen, detectedMatches) {
  for (const pattern of exactPatterns) {
    pattern.lastIndex = 0
    for (const match of sourceText.matchAll(pattern)) {
      const first = match[1]
      const second = match[2]
      const method = /^[A-Z]+$/.test(first) ? first : second
      const path = /^[A-Z]+$/.test(first) ? second : first
      addEndpoint(endpoints, seen, method, path, 'exact')
    }
  }

  // p.match(...) or url.pathname.match(...)
  const matchPattern = /const\s+(\w+Match)\s*=\s*(?:p|url\.pathname)\.match\(/g
  for (const match of sourceText.matchAll(matchPattern)) {
    const variable = match[1]
    detectedMatches.add(variable)
    if (ignoredDynamicMatches.has(variable)) continue

    const routes = dynamicRoutes[variable]
    if (!routes) {
      throw new Error(`Unmapped dynamic route ${variable}; add it to dynamicRoutes in extract-endpoints.mjs`)
    }
    const nearbySource = sourceText.slice(match.index, match.index + 800)
    const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const methodPattern = new RegExp(
      `if \\(${escapedVariable}\\s*&&\\s*(?:m|req\\.method) === '([A-Z]+)'\\)`,
      'g',
    )
    const detectedMethods = new Set(
      [...nearbySource.matchAll(methodPattern)].map((methodMatch) => methodMatch[1]),
    )
    const expectedMethods = new Set(routes.map(([method]) => method))
    if (
      detectedMethods.size !== expectedMethods.size
      || [...expectedMethods].some((method) => !detectedMethods.has(method))
    ) {
      throw new Error(
        `${variable} is mapped as ${[...expectedMethods].join(', ')} but sources dispatch ${[...detectedMethods].join(', ') || 'an unknown method'}`,
      )
    }
    for (const [method, path] of routes) addEndpoint(endpoints, seen, method, path, 'dynamic')
  }
}

function extractEndpoints() {
  const endpoints = []
  const seen = new Set()
  const detectedMatches = new Set()
  const sources = listWebSources()

  for (const file of sources) {
    extractFromText(readFileSync(file, 'utf8'), endpoints, seen, detectedMatches)
  }

  for (const variable of Object.keys(dynamicRoutes)) {
    if (!detectedMatches.has(variable)) {
      throw new Error(`Stale dynamic route mapping ${variable}; it no longer exists under src/web/`)
    }
  }

  return {
    sources: sources.map((p) => p.slice(root.length + 1)),
    endpoints: endpoints.sort((a, b) => routeKey(a).localeCompare(routeKey(b))),
  }
}

function serialize(result) {
  return `${JSON.stringify({
    generatedFrom: 'src/web/*.ts (composition root + domain *-api modules)',
    scope: 'REST routes handled by startWebServer and its domain dispatchers',
    sourceFiles: result.sources,
    count: result.endpoints.length,
    endpoints: result.endpoints,
  }, null, 2)}\n`
}

function readManifest() {
  try {
    return readFileSync(manifestPath, 'utf8')
  } catch {
    return ''
  }
}

function printRouteDiff(currentText, endpoints) {
  let currentEndpoints = []
  try {
    currentEndpoints = JSON.parse(currentText).endpoints ?? []
  } catch {
    console.error('  Existing endpoints.json is missing or invalid JSON.')
  }
  const currentKeys = new Set(currentEndpoints.map(routeKey))
  const nextKeys = new Set(endpoints.map(routeKey))
  for (const key of [...nextKeys].filter((key) => !currentKeys.has(key))) {
    console.error(`  + ${key}`)
  }
  for (const key of [...currentKeys].filter((key) => !nextKeys.has(key))) {
    console.error(`  - ${key}`)
  }
}

const result = extractEndpoints()
const next = serialize(result)

if (checkMode) {
  const current = readManifest()
  if (current !== next) {
    console.error('✗ tools/endpoints.json is stale.')
    printRouteDiff(current, result.endpoints)
    console.error('  Run `npm --prefix src/web-app run update-endpoints` and review the manifest diff.')
    process.exitCode = 1
  } else {
    console.log(`✓ ${result.endpoints.length} REST routes match tools/endpoints.json`)
  }
} else {
  writeFileSync(manifestPath, next)
  console.log(`Wrote ${result.endpoints.length} REST routes to tools/endpoints.json`)
}
