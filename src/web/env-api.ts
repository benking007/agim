// env-api — web REST surface for environment variable management and
// security diagnostics.
//
// Endpoints exposed:
//
//   GET  /api/env                      → { env, secretKeys }
//   PUT  /api/env                      body { updates }  → { ok, updated }
//   GET  /api/security/diagnostics     → { diagnostics }
//
// All routes require admin (same gates as the original server.ts route table).

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isMasked, maskSecret } from './env-mask.js'
import { getRequestActor, requireAdmin } from './auth.js'
import { sendJson, sendError, readBody } from './http-utils.js'

// ─── env key allowlists ──────────────────────────────────────────────

export const ENV_EDITABLE_KEYS = [
  'AGIM_SMTP_HOST', 'AGIM_SMTP_PORT', 'AGIM_SMTP_USER', 'AGIM_SMTP_PASS',
  'AGIM_SMTP_FROM', 'AGIM_SMTP_SECURE',
  'AGIM_BAIDU_MAP_AK',
  'AGIM_LOC_BASE_URL', 'AGIM_TZ_OFFSET_HOURS',
  // Safety card toggle — drives the Claude --dangerously-skip-permissions
  // branch in plugins/agents/claude-code/index.ts. Not a secret, plain '1'/'0'.
  'AGIM_DANGEROUSLY_SKIP_PERMISSIONS',
  // Approval Policy card. AGIM_AUTO_APPROVE defaults OFF; AGIM_APPROVAL_ON_TIMEOUT
  // (legacy AGIM_TIMEOUT_DEFAULT) defaults allow and only matters when
  // auto-approve is off. Timeout-default hot-reloads because approval-bus
  // reads process.env on timer fire; the timeout duration itself is captured
  // by the singleton bus and needs restart.
  'AGIM_TIMEOUT_DEFAULT',
  'AGIM_APPROVAL_ON_TIMEOUT',
  'AGIM_AUTO_APPROVE',
  'AGIM_APPROVAL_TIMEOUT_MS',
  // v1.2 — IM long-message viewer. Operator sets the public URL pointing at
  // their reverse-proxied agim web port; thresholds tune when routing kicks
  // in. Hot-reload works because viewer-config reads process.env every call.
  'AGIM_VIEWER_ENABLED',
  'AGIM_VIEWER_PUBLIC_BASE_URL',
  'AGIM_VIEWER_CHARS',
  'AGIM_VIEWER_LINES',
  'AGIM_VIEWER_CODE_LINES',
  'AGIM_VIEWER_MAX_PASTES',
  'AGIM_VIEWER_TUNNEL_MODE',
  // v1.2.43 — opt out of community default paste server (viewer.iclaw.host).
  'AGIM_VIEWER_NO_DEFAULT_REMOTE',
  // v1.1.10 — A2A notification settings (see src/core/a2a-notify.ts).
  'AGIM_A2A_TIMEOUT_DEFAULT_MS',
  'AGIM_A2A_MAX_TIMEOUT_MS',
  'AGIM_A2A_NOTIFY_MODE',
  'AGIM_A2A_NOTIFY_MAX_DEPTH',
  'AGIM_A2A_HEARTBEAT_MIN',
  // v1.5 — long-term memory (see src/core/memory.ts + persona.ts).
  'AGIM_MEMORY_ENABLED',
  // P1/P2 — dream distillation (background fact extraction; see
  // src/core/memory-distiller.ts).
  'AGIM_MEMORY_DISTILL_ENABLED',
  'AGIM_MEMORY_DISTILL_SOURCE',
  'AGIM_MEMORY_DISTILL_AGENT',
  'AGIM_MEMORY_DISTILL_INTERVAL_MS',
  'AGIM_MEMORY_DISTILL_FLOOR_MIN',
  'AGIM_MEMORY_DISTILL_BATCH_MAX',
  'AGIM_MEMORY_DISTILL_MAX_PENDING',
  // v1.6 — vector retrieval (opt-in, OFF by default).
  'AGIM_MEMORY_VECTOR_BACKEND',
  'AGIM_MEMORY_VECTOR_LOCAL_MODEL',
  'AGIM_MEMORY_VECTOR_OPENAI_BASE_URL',
  'AGIM_MEMORY_VECTOR_OPENAI_MODEL',
  'AGIM_MEMORY_VECTOR_OPENAI_API_KEY',
  'AGIM_MEMORY_VECTOR_BATCH_SIZE',
  'AGIM_MEMORY_VECTOR_HYBRID_WEIGHT',
  // v1.2.67 — Security page surfaces these (added in v1.2.58–v1.2.66).
  // Sender allowlist — who can talk to the bot at all.
  'AGIM_ALLOWED_USERS',
  // Native fs tools — workspace restriction + per-tool timeout.
  'AGIM_NATIVE_FS_RESTRICT',
  'AGIM_NATIVE_FS_TIMEOUT_MS',
  // Native web tools — SSRF guards.
  'AGIM_NATIVE_WEB_ALLOW_PRIVATE',
  'AGIM_NATIVE_WEB_SSRF_WHITELIST',
  'AGIM_NATIVE_WEB_TIMEOUT_MS',
  // Native exec tool — bwrap sandbox + sub-knobs.
  'AGIM_EXEC_SANDBOX',
  'AGIM_EXEC_SANDBOX_NET',
  'AGIM_EXEC_TIMEOUT_MS',
  'AGIM_EXEC_MAX_OUTPUT',
  // Native call_agent per-turn cap.
  'AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN',
  // v1.2.69 — IM platform blacklist (CSV of platform ids). Default
  // empty (no blocks); listed platforms vanish from web + CLI + are
  // refused at registry.registerMessenger.
  'AGIM_PLATFORM_BLACKLIST',
  // v1.2.126 — web_search provider chain (CSV) + each provider's API
  // key. `AGIM_WEB_SEARCH_PROVIDERS` orders the fallback chain (e.g.
  // 'tavily,brave,duckduckgo'); a missing/empty value falls back to
  // DEFAULT_PROVIDER_ORDER in web-dispatcher. The 5 *_API_KEY values
  // gate per-provider availability (duckduckgo needs no key).
  'AGIM_WEB_SEARCH_PROVIDERS',
  'TAVILY_API_KEY',
  'BRAVE_API_KEY',
  'SERPER_API_KEY',
  'EXA_API_KEY',
  'METASO_API_KEY',
  // Speech-to-text — all AGIM_STT_* (never share LLM vendor keys).
  'AGIM_STT_PROVIDER',
  'AGIM_STT_OPENAI_API_KEY',
  'AGIM_STT_OPENAI_BASE_URL',
  'AGIM_STT_OPENAI_MODEL',
  'AGIM_STT_BAIDU_API_KEY',
  'AGIM_STT_BAIDU_SECRET_KEY',
  'AGIM_STT_TENCENT_SECRET_ID',
  'AGIM_STT_TENCENT_SECRET_KEY',
  'AGIM_STT_TENCENT_ENGINE',
  'AGIM_STT_IFLYTEK_APP_ID',
  'AGIM_STT_IFLYTEK_API_KEY',
  'AGIM_STT_IFLYTEK_API_SECRET',
  'AGIM_STT_ZHIPU_API_KEY',
  'AGIM_STT_ZHIPU_BASE_URL',
  'AGIM_STT_ZHIPU_MODEL',
  'AGIM_STT_MIMO_API_KEY',
  'AGIM_STT_MIMO_BASE_URL',
  'AGIM_STT_MIMO_MODEL',
  'AGIM_STT_STEPFUN_API_KEY',
  'AGIM_STT_STEPFUN_BASE_URL',
  'AGIM_STT_STEPFUN_MODEL',
  // whisper.cpp AGIM_STT_WHISPERCPP_* are host/ops-only — not SPA-editable.
  // v1.2.126 — per-tool runtime caps (result chars / wall timeout),
  // enforced in the pi tool bridge for the native path. Re-read per
  // call, so editing takes effect without a restart.
  'AGIM_NATIVE_TOOL_RESULT_MAX_CHARS',
  'AGIM_NATIVE_TOOL_TIMEOUT_MS',
  // v1.2.127 — A2A sub-agent spawn (depth / timeout / in-process /
  // per-turn cap). All hot-read; flipping in-process to 'off' makes
  // the next call_agent('native', …) reboot via the subprocess CLI
  // adapter instead of the v1.2.121 fast path.
  'AGIM_A2A_MAX_DEPTH',
  'AGIM_A2A_TIMEOUT_DEFAULT_MS',
  'AGIM_NATIVE_CALL_AGENT_IN_PROCESS',
  'AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN',
  // Plan mode default state. Canonical AGIM_PLAN_MODE=on|off|disabled;
  // legacy AGIM_NATIVE_PLAN_MODE / AGIM_DISABLE_PLAN_MODE still read.
  'AGIM_NATIVE_PLAN_MODE',
  'AGIM_PLAN_MODE',
  'AGIM_DISABLE_PLAN_MODE',
  // v1.2.135 — auto-enter heuristic + custom phrase list.
  'AGIM_PLAN_INTENT_AUTO',
  'AGIM_PLAN_INTENT_PHRASES',
  // Per-turn iteration cap.
  'AGIM_NATIVE_AGENT_MAX_ITER',
  'AGIM_NATIVE_AGENT_MAX_TOOL_CALLS',
  // Active pi-native AgentHarness loop watchdog (0 disables).
  'AGIM_NATIVE_TURN_TIMEOUT_MS',
  // Approval / role policy for Agim Agent (pi-native). SPA
  // /settings/native-agent writes these; they were previously dropped
  // by the allowlist filter (silent Save no-op).
  'AGIM_NATIVE_AGENT_ROLE',
  'AGIM_NATIVE_AGENT_MODE',
  'AGIM_NATIVE_AGENT_AUTOALLOW',
  'AGIM_NATIVE_AGENT_DENYLIST',
  // Notification evaluator + heartbeat (same SPA page).
  'AGIM_NOTIFICATION_EVALUATOR',
  'AGIM_NOTIFICATION_EVALUATOR_SOURCES',
  'AGIM_HEARTBEAT_ENABLED',
  'AGIM_HEARTBEAT_TICK_INTERVAL_MS',
  'AGIM_HEARTBEAT_DEFAULT_INTERVAL_MIN',
  // Live on pi-native (goal critic + semantic stuck soft→hard). Ops-tunable
  // via /api/env; not every knob has a dedicated SPA control yet.
  'AGIM_NATIVE_CRITIC',
  'AGIM_NATIVE_CRITIC_ROLE',
  'AGIM_NATIVE_SEMANTIC_STUCK_LOOP',
  // Context budget (tool-result clearing + late compaction). Prefer AGIM_CTX_*.
  'AGIM_CTX_COMPACT',
  'AGIM_CTX_COMPACT_RESERVE_TOKENS',
  'AGIM_CTX_COMPACT_KEEP_RECENT_TOKENS',
  'AGIM_CTX_COMPACT_INSTRUCTIONS',
  'AGIM_CTX_LOOKAHEAD_TOKENS',
  'AGIM_CTX_CLEAR',
  'AGIM_CTX_CLEAR_TRIGGER_TOKENS',
  'AGIM_CTX_CLEAR_KEEP_TOOL_USES',
  'AGIM_CTX_CLEAR_AT_LEAST_CHARS',
  'AGIM_CTX_CLEAR_EXCLUDE',
  // Legacy aliases (still honored by the runtime).
  'AGIM_NATIVE_COMPACTION',
  'AGIM_CTX_CLEARING',
] as const

export const SECRET_KEYS = new Set<string>([
  'AGIM_SMTP_PASS',
  'AGIM_BAIDU_MAP_AK',
  'AGIM_MEMORY_VECTOR_OPENAI_API_KEY',
  // v1.2.126 — web search keys are bearer tokens / API keys, so
  // they're masked on GET and refused if echoed back on PUT.
  'TAVILY_API_KEY',
  'BRAVE_API_KEY',
  'SERPER_API_KEY',
  'EXA_API_KEY',
  'METASO_API_KEY',
  'AGIM_STT_OPENAI_API_KEY',
  'AGIM_STT_BAIDU_API_KEY',
  'AGIM_STT_BAIDU_SECRET_KEY',
  'AGIM_STT_TENCENT_SECRET_ID',
  'AGIM_STT_TENCENT_SECRET_KEY',
  'AGIM_STT_IFLYTEK_API_KEY',
  'AGIM_STT_IFLYTEK_API_SECRET',
  'AGIM_STT_ZHIPU_API_KEY',
  'AGIM_STT_MIMO_API_KEY',
  'AGIM_STT_STEPFUN_API_KEY',
])

// ─── routing ────────────────────────────────────────────────────────

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served (caller should stop walking its own route table); `false`
 * when the URL/method didn't match anything in this module.
 */
export async function handleEnvApi(
  req: IncomingMessage, res: ServerResponse, url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/env' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleGetEnv(res, url); return true
  }
  if (p === '/api/env' && m === 'PUT') {
    if (!requireAdmin(req, res)) return true
    await handlePutEnv(req, res); return true
  }
  if (p === '/api/security/diagnostics' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleSecurityDiagnostics(res); return true
  }
  return false
}

// ─── handlers ───────────────────────────────────────────────────────

/** v1.2.67 — Security diagnostics endpoint. Returns the boot-time
 *  safety observations the Security UI page renders as badges. None
 *  of the values are secret; the endpoint is admin-gated only to
 *  prevent reconnaissance via an open UI. */
async function handleSecurityDiagnostics(res: ServerResponse): Promise<void> {
  try {
    const { ENV_FILE } = await import('../cli-ui/env-file.js')
    const { statSync, existsSync } = await import('node:fs')

    const getUid = (process as unknown as { getuid?: () => number }).getuid
    const runningAsRoot = typeof getUid === 'function' ? getUid() === 0 : null

    let envFile: { exists: boolean; mode: string | null; tooPermissive: boolean } = {
      exists: false, mode: null, tooPermissive: false,
    }
    try {
      if (existsSync(ENV_FILE)) {
        const st = statSync(ENV_FILE)
        const mode = st.mode & 0o777
        envFile = {
          exists: true,
          mode: mode.toString(8).padStart(3, '0'),
          tooPermissive: (mode & 0o077) !== 0,
        }
      }
    } catch { /* leave defaults */ }

    const bwrapAvailable = existsSync('/usr/bin/bwrap')

    const { isSenderAllowlistConfigured } = await import('../core/sender-allowlist.js')
    const senderAllowlistConfigured = isSenderAllowlistConfigured()

    const { isAllowlistConfigured: isAdminConfigured } = await import('../core/admin-allowlist.js')
    const adminAllowlistConfigured = isAdminConfigured()

    const { getPlatformBlacklist } = await import('../core/registry.js')
    const platformBlacklist = getPlatformBlacklist()

    sendJson(res, 200, {
      diagnostics: {
        runningAsRoot,
        envFile,
        bwrapAvailable,
        senderAllowlistConfigured,
        adminAllowlistConfigured,
        platformBlacklist,
        // Live env values so the UI can show what's effectively in force
        // (process.env, which is what runtime sees) without round-tripping
        // through the env file.
        liveEnv: {
          AGIM_EXEC_SANDBOX: process.env.AGIM_EXEC_SANDBOX ?? null,
          AGIM_NATIVE_FS_RESTRICT: process.env.AGIM_NATIVE_FS_RESTRICT ?? null,
          AGIM_TIMEOUT_DEFAULT: process.env.AGIM_APPROVAL_ON_TIMEOUT
            ?? process.env.AGIM_TIMEOUT_DEFAULT
            ?? null,
          AGIM_APPROVAL_ON_TIMEOUT: process.env.AGIM_APPROVAL_ON_TIMEOUT
            ?? process.env.AGIM_TIMEOUT_DEFAULT
            ?? null,
          AGIM_AUTO_APPROVE: process.env.AGIM_AUTO_APPROVE ?? null,
          AGIM_APPROVAL_TIMEOUT_MS: process.env.AGIM_APPROVAL_TIMEOUT_MS ?? null,
          AGIM_DANGEROUSLY_SKIP_PERMISSIONS: process.env.AGIM_DANGEROUSLY_SKIP_PERMISSIONS ?? null,
        },
      },
    })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleGetEnv(res: ServerResponse, url: URL): Promise<void> {
  try {
    const { readEnvFile } = await import('../cli-ui/env-file.js')
    const env = readEnvFile()
    const reveal = url.searchParams.get('reveal') === '1'
    const out: Record<string, string> = {}
    for (const key of ENV_EDITABLE_KEYS) {
      const v = env[key]
      if (v === undefined) continue
      out[key] = reveal ? v : (SECRET_KEYS.has(key) ? maskSecret(v) : v)
    }
    sendJson(res, 200, { env: out, secretKeys: Array.from(SECRET_KEYS) })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

async function handlePutEnv(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const parsed = JSON.parse(body || '{}') as { updates?: Record<string, string | null> }
    const updates = parsed.updates
    if (!updates || typeof updates !== 'object') {
      sendError(res, 400, 'ENV_UPDATES_REQUIRED', { message: 'updates object required' })
      return
    }
    // Filter to whitelist — never let arbitrary keys through.
    const safe: Record<string, string | null> = {}
    for (const [k, v] of Object.entries(updates)) {
      if (!(ENV_EDITABLE_KEYS as readonly string[]).includes(k)) continue
      if (v === null || typeof v === 'string') {
        // Defense in depth: if the client echoes a masked secret value
        // (e.g. "abcd****wxyz") back into PUT, treat it as "no change" and
        // skip the update so the real value isn't overwritten by the mask.
        if (SECRET_KEYS.has(k) && typeof v === 'string' && isMasked(v)) continue
        safe[k] = v
      }
    }
    if (Object.keys(safe).length === 0) {
      sendError(res, 400, 'ENV_NO_EDITABLE_KEYS', { message: 'no editable keys in updates' })
      return
    }
    const { updateEnvFile } = await import('../cli-ui/env-file.js')
    updateEnvFile(safe)
    // Hot-reload: mutate process.env so modules that re-read on use (e.g.
    // approval-bus's isTimeoutDefaultAllow) pick up the change without
    // waiting for a service restart. Modules that capture at module load
    // (most SMTP / Baidu callers) still need a restart to see the new value
    // — that's a per-module decision, not enforced here.
    for (const [k, v] of Object.entries(safe)) {
      if (v === null) delete process.env[k]
      else process.env[k] = v
    }
    // R12 ⑤ — persistent audit. Track WHICH keys were touched, never the
    // values themselves (env can hold SMTP_PASS, BAIDU_AK, etc.).
    try {
      const { logAuditEvent } = await import('../core/audit-log.js')
      logAuditEvent({
        eventType: 'env.put',
        actor: getRequestActor(req),
        outcome: 'ok',
        details: { keys: Object.keys(safe) },
      })
    } catch { /* best-effort */ }
    sendJson(res, 200, { ok: true, updated: Object.keys(safe) })
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}
