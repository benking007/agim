#!/usr/bin/env node
/**
 * Extract the REST routes dispatched directly by src/web/server.ts.
 *
 * Default mode updates tools/endpoints.json. `--check` compares the fresh
 * extraction with the committed manifest without touching the worktree.
 * Delegated protocol routers (/api/llm, /api/mcp, /api/goals, and similar)
 * are intentionally out of scope because their routes live in other modules.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const toolDir = dirname(fileURLToPath(import.meta.url))
const root = resolve(toolDir, '../../..')
const serverPath = resolve(root, 'src/web/server.ts')
const manifestPath = resolve(toolDir, 'endpoints.json')
const checkMode = process.argv.includes('--check')

const publicRoutes = new Set([
  'POST /api/auth/login',
  'GET /api/health',
  'POST /api/loc',
  'GET /api/loc/info',
])

// Regex routes cannot be recovered reliably from arbitrary regular
// expressions. Keeping this small map explicit makes additions reviewable;
// the detector below fails when server.ts introduces an unmapped *Match.
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
}

const ignoredDynamicMatches = new Set([
  // Public HTML viewer route, not REST.
  'viewerMatch',
])

const exactPatterns = [
  /if \(url\.pathname === '([^']+)'\s*&&\s*req\.method === '([A-Z]+)'\)/g,
  /if \(req\.method === '([A-Z]+)'\s*&&\s*url\.pathname === '([^']+)'\)/g,
]

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

function extractEndpoints(sourceText) {
  const endpoints = []
  const seen = new Set()

  for (const pattern of exactPatterns) {
    for (const match of sourceText.matchAll(pattern)) {
      const first = match[1]
      const second = match[2]
      const method = /^[A-Z]+$/.test(first) ? first : second
      const path = /^[A-Z]+$/.test(first) ? second : first
      addEndpoint(endpoints, seen, method, path, 'exact')
    }
  }

  const detectedMatches = new Set()
  const matchPattern = /const\s+(\w+Match)\s*=\s*url\.pathname\.match\(/g
  for (const match of sourceText.matchAll(matchPattern)) {
    const variable = match[1]
    detectedMatches.add(variable)
    if (ignoredDynamicMatches.has(variable)) continue

    const routes = dynamicRoutes[variable]
    if (!routes) {
      throw new Error(`Unmapped dynamic route ${variable}; add it to dynamicRoutes`)
    }
    const nearbySource = sourceText.slice(match.index, match.index + 600)
    const escapedVariable = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const methodPattern = new RegExp(
      `if \\(${escapedVariable}\\s*&&\\s*req\\.method === '([A-Z]+)'\\)`,
      'g',
    )
    const detectedMethods = new Set([...nearbySource.matchAll(methodPattern)].map((methodMatch) => methodMatch[1]))
    const expectedMethods = new Set(routes.map(([method]) => method))
    if (
      detectedMethods.size !== expectedMethods.size
      || [...expectedMethods].some((method) => !detectedMethods.has(method))
    ) {
      throw new Error(
        `${variable} is mapped as ${[...expectedMethods].join(', ')} but server.ts dispatches ${[...detectedMethods].join(', ') || 'an unknown method'}`,
      )
    }
    for (const [method, path] of routes) addEndpoint(endpoints, seen, method, path, 'dynamic')
  }

  for (const variable of Object.keys(dynamicRoutes)) {
    if (!detectedMatches.has(variable)) {
      throw new Error(`Stale dynamic route mapping ${variable}; it no longer exists in server.ts`)
    }
  }

  return endpoints.sort((a, b) => routeKey(a).localeCompare(routeKey(b)))
}

function serialize(endpoints) {
  return `${JSON.stringify({
    generatedFrom: 'src/web/server.ts',
    scope: 'REST routes dispatched directly by startWebServer',
    count: endpoints.length,
    endpoints,
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

const endpoints = extractEndpoints(readFileSync(serverPath, 'utf8'))
const next = serialize(endpoints)

if (checkMode) {
  const current = readManifest()
  if (current !== next) {
    console.error('✗ tools/endpoints.json is stale.')
    printRouteDiff(current, endpoints)
    console.error('  Run `npm --prefix src/web-app run update-endpoints` and review the manifest diff.')
    process.exitCode = 1
  } else {
    console.log(`✓ ${endpoints.length} direct REST routes match tools/endpoints.json`)
  }
} else {
  writeFileSync(manifestPath, next)
  console.log(`Wrote ${endpoints.length} direct REST routes to tools/endpoints.json`)
}
