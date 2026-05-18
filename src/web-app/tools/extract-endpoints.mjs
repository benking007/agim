#!/usr/bin/env node
/**
 * extract-endpoints.mjs — scan src/web/server.ts and emit a JSON file
 * describing every REST endpoint the agim backend exposes.
 *
 * Output: tools/endpoints.json (commit alongside source so the
 * generated lib/api/endpoints.ts is reproducible without re-running
 * this script on every CI build).
 *
 * Approach is intentionally regex-based, not AST. server.ts uses a
 * very consistent pattern:
 *
 *   if (url.pathname === '/api/foo' && req.method === 'GET') { ... }
 *   if (url.pathname.startsWith('/api/foo/') && req.method === 'POST') { ... }
 *
 * Regex is good enough for that shape; an AST visitor would be 10×
 * the code for the same coverage. Hand-edit endpoints.json (or this
 * file's NAME_OVERRIDES below) if a new route pattern slips past.
 *
 * Run:
 *   node tools/extract-endpoints.mjs
 *
 * Re-run only when src/web/server.ts grows / loses a route — the
 * resulting endpoints.json is the source of truth for the generator.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '../../..')
const SERVER_TS = resolve(ROOT, 'src/web/server.ts')
const OUT_JSON = resolve(__dirname, 'endpoints.json')

const text = readFileSync(SERVER_TS, 'utf-8')

// ─── Patterns ───────────────────────────────────────────────────────
// Capture: method, pathname, kind (=== vs startsWith).
//
//   if (url.pathname === '/api/jobs' && req.method === 'GET')
//   if (req.method === 'GET' && url.pathname === '/api/jobs')
//   if (url.pathname.startsWith('/api/jobs/') && req.method === 'POST')
//
// We DO NOT match the few backwards-form `if (req.method === 'GET' &&
// url.pathname.startsWith...)` lines (none exist as of 2026-05-18,
// per a manual sweep). If one shows up later, append a pattern here.
const PATTERNS = [
  /if \(url\.pathname === '([^']+)'\s*&&\s*req\.method === '([A-Z]+)'\)/g,
  /if \(req\.method === '([A-Z]+)'\s*&&\s*url\.pathname === '([^']+)'\)/g,
  /if \(url\.pathname\.startsWith\('([^']+)'\)\s*&&\s*req\.method === '([A-Z]+)'\)/g,
  /if \(req\.method === '([A-Z]+)'\s*&&\s*url\.pathname\.startsWith\('([^']+)'\)\)/g,
]

// Match dynamic path segments that follow `pathname.startsWith(...)`
// and are sliced off in the same block — produces /api/jobs/:id form
// for the manifest. Not exhaustive (some routes parse the id manually
// inside the block); NAME_OVERRIDES below patches the long tail.
const NAME_OVERRIDES = {
  // Manually pin a stable function name when the route's path doesn't
  // map cleanly (e.g. /api/jobs/batch-run -> batchRunJobs).
  'GET /api/health': 'getHealth',
  'GET /api/agents/status': 'getAgentsStatus',
  'POST /api/agents/acp/test': 'testAcpAgent',
  'POST /api/agents/acp/discover': 'discoverAcpAgents',
  'POST /api/jobs/batch-run': 'batchRunJobs',
  'POST /api/jobs/batch-cancel': 'batchCancelJobs',
  'GET /api/health/summary': 'getHealthSummary',
  'GET /api/health/topn': 'getHealthTopN',
  'GET /api/outbox/stats': 'getOutboxStats',
  'GET /api/a2a/stats': 'getA2AStats',
  'GET /api/a2a/recent': 'getA2ARecent',
  'GET /api/messengers/wechat/qr-start': 'startWechatQr',
  'POST /api/messengers/wechat/qr-start': 'startWechatQr',
  'GET /api/messengers/wechat/qr-status': 'getWechatQrStatus',
  'GET /api/service/status': 'getServiceStatus',
  'POST /api/service/start': 'startService',
  'POST /api/service/stop': 'stopService',
  'POST /api/service/restart': 'restartService',
  'GET /api/admin-allowlist': 'listAdminAllowlist',
  'POST /api/admin-allowlist': 'addAdminAllowlist',
  'DELETE /api/admin-allowlist': 'removeAdminAllowlist',
  'GET /api/viewer/tunnel': 'getViewerTunnel',
  'POST /api/memory/vector/test': 'testMemoryVector',
  'POST /api/memory/vector/download': 'downloadMemoryVector',
  'POST /api/memory/vector/backfill': 'backfillMemoryVector',
  'POST /api/memory/vector/clear': 'clearMemoryVector',
  'GET /api/memory/vector/status': 'getMemoryVectorStatus',
  'GET /api/memory/consolidate/status': 'getMemoryConsolidateStatus',
  'POST /api/memory/consolidate': 'consolidateMemory',
  'GET /api/memory/users': 'listMemoryUsers',
  'GET /api/memory/facts': 'listMemoryFacts',
  'DELETE /api/memory/facts': 'deleteMemoryFacts',
  'GET /api/memory/persona': 'getMemoryPersona',
  'PUT /api/memory/persona': 'updateMemoryPersona',
  'DELETE /api/memory/persona': 'deleteMemoryPersona',
  'GET /api/memory/export': 'exportMemory',
  'GET /api/skills/remote/hot': 'getSkillsRemoteHot',
  'GET /api/auth/login': 'loginGet',
  'POST /api/auth/login': 'login',
  'POST /api/auth/logout': 'logout',
  'GET /api/loc/info': 'getLocInfo',
  'POST /api/loc': 'submitLoc',
  'POST /api/notify': 'notify',
  'POST /api/invoke': 'invoke',
  'GET /api/viewer': 'listViewerPastes',
  'GET /api/workspace-files': 'getWorkspaceFiles',
  'PUT /api/workspace-files': 'writeWorkspaceFile',
  // Singularize core collection POSTs so the function name reads as
  // "create one thing" rather than "create many things".
  'POST /api/jobs': 'createJob',
  'POST /api/workspaces': 'createWorkspace',
  'POST /api/approvals': 'createApproval',
  // Singular GETs that return one object (not a list). `listConfig` /
  // `listEnv` etc. read wrong.
  'GET /api/config': 'getConfig',
  'PUT /api/config': 'updateConfig',
  'GET /api/env': 'getEnv',
  'PUT /api/env': 'updateEnv',
  'GET /api/metrics': 'getMetrics',
  'GET /api/audit': 'getAudit',
  'GET /api/agent-health': 'getAgentHealth',
  'GET /api/workspaces': 'listWorkspaces',
  'GET /api/skills': 'listSkills',
  'GET /api/reminders': 'listReminders',
  'GET /api/memos': 'listMemos',
  'GET /api/jobs': 'listJobs',
  'GET /api/bgjobs': 'listBgJobs',
  'GET /api/subtasks': 'listSubtasks',
  'GET /api/schedules': 'listSchedules',
  'GET /api/approvals': 'listApprovals',
  'GET /api/outbox': 'listOutbox',
}

const SKIP_PATHS = new Set([
  // SSR routes — public pages served as HTML, not part of the API
  // surface the SPA consumes via fetch.
  '/login',
  '/loc',
  '/v/',
  '/l/',
  '/_app.js',
  '/_shell.css',
  '/vendor/',
  // SSE / WS handled separately, NOT REST.
  '/events',
  '/ws',
  // Already-served static HTML files (M4 removes these).
  '/',
  '/index.html',
  '/settings',
  '/settings.html',
  '/tasks',
  '/tasks.html',
  '/reminders',
  '/reminders.html',
  '/memos',
  '/memos.html',
  '/approvals',
  '/approvals.html',
  '/memory',
  '/memory.html',
  '/workspace',
  '/workspace.html',
  '/observability',
  '/observability.html',
])

const SKIP_PREFIXES = ['/vendor/', '/v/', '/l/']

const PUBLIC = new Set([
  '/api/auth/login',
  '/api/health',
  '/api/loc',
  '/api/loc/info',
])

// ─── Extraction ─────────────────────────────────────────────────────
const seen = new Set()
const endpoints = []

for (const re of PATTERNS) {
  let m
  while ((m = re.exec(text)) !== null) {
    // Pattern variants put method/path in different capture groups.
    // Normalize by detecting which capture looks like a method.
    let methodCap, pathCap
    if (/^[A-Z]+$/.test(m[1])) {
      methodCap = m[1]
      pathCap = m[2]
    } else {
      methodCap = m[2]
      pathCap = m[1]
    }
    if (SKIP_PATHS.has(pathCap)) continue
    if (SKIP_PREFIXES.some((p) => pathCap.startsWith(p))) continue
    // Trim trailing slash from startsWith() matches and tag dynamic
    // segments with `:param`. Most agim routes that use startsWith
    // are of the shape `/api/jobs/` so we cheat and append `:id`.
    let path = pathCap
    let isPrefix = false
    if (re.source.includes('startsWith')) {
      isPrefix = true
      path = path.replace(/\/$/, '') + '/:id'
    }
    const key = `${methodCap} ${path}`
    if (seen.has(key)) continue
    seen.add(key)
    endpoints.push({
      method: methodCap,
      path,
      isPrefix,
      name: NAME_OVERRIDES[key] || synthName(methodCap, path),
      authRequired: !PUBLIC.has(path),
    })
  }
}

// Stable sort by path then method so diffs are reviewable.
endpoints.sort((a, b) => {
  if (a.path === b.path) return a.method.localeCompare(b.method)
  return a.path.localeCompare(b.path)
})

// ─── Helpers ────────────────────────────────────────────────────────
/**
 * Derive a function name when no override is provided:
 *   GET /api/jobs              -> listJobs
 *   GET /api/jobs/:id          -> getJob
 *   POST /api/jobs             -> createJob
 *   PUT /api/foo/bar           -> updateFooBar
 *   DELETE /api/foo            -> deleteFoo
 * The synthesizer is best-effort; anything ambiguous belongs in
 * NAME_OVERRIDES above.
 */
function synthName(method, path) {
  const segs = path.replace(/^\/api\//, '').split('/').filter(Boolean)
  const hasParam = segs.some((s) => s.startsWith(':'))
  const baseSegs = segs.filter((s) => !s.startsWith(':'))
  const noun = camelCaseFromSegs(baseSegs)
  // For GET-on-collection, the noun is usually already plural
  // ("jobs", "schedules") — don't tack on a second `s`. Singular
  // resource nouns ("audit", "health") read fine as `listAudit`.
  switch (method) {
    case 'GET':    return hasParam ? `get${capitalize(noun)}` : `list${capitalize(noun)}`
    case 'POST':   return `create${capitalize(noun)}`
    case 'PUT':    return `update${capitalize(noun)}`
    case 'PATCH':  return `update${capitalize(noun)}`
    case 'DELETE': return `delete${capitalize(noun)}`
    default:       return `${method.toLowerCase()}${capitalize(noun)}`
  }
}
function camelCaseFromSegs(segs) {
  return segs
    .map((s, i) => (i === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join('')
    .replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ─── Write ──────────────────────────────────────────────────────────
writeFileSync(OUT_JSON, JSON.stringify({ generatedFrom: 'src/web/server.ts', count: endpoints.length, endpoints }, null, 2) + '\n')
console.log(`Wrote ${endpoints.length} endpoints to ${OUT_JSON.replace(ROOT + '/', '')}`)
