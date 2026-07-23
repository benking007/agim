// v1.2.127 — regression pins for the ENV_EDITABLE_KEYS allowlist in
// src/web/server.ts. The PUT /api/env handler refuses any key that
// isn't listed here, so a typo in this list silently breaks the
// admin UI's Save button without any compile-time signal. This test
// is the only thing that catches that — it parses the source and
// asserts every key the SPA tries to write is present.
//
// We don't import server.ts directly (its boot-time side effects
// touch sqlite + admin allowlist seeding). Reading the source as
// text and matching the array literal is both faster and avoids
// having to teardown those side effects.

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER_TS = join(HERE, '..', '..', 'src', 'web', 'server.ts')
const NATIVE_AGENT_TSX = join(
  HERE, '..', '..', 'src', 'web-app', 'src', 'routes', 'settings', 'native-agent.tsx',
)

function readAllowedKeys(): Set<string> {
  const src = readFileSync(SERVER_TS, 'utf8')
  const match = src.match(/const ENV_EDITABLE_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const/)
  if (!match) throw new Error('ENV_EDITABLE_KEYS array literal not found in server.ts')
  const keys = new Set<string>()
  // Walk line by line; a real entry is a line whose first non-space
  // char is a quote. This skips //-comments AND skips comment-only
  // lines that happen to mention an env-key name in backticks. Each
  // entry is `'KEY',` so the first single-quoted token wins.
  for (const line of match[1].split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("'")) continue
    const m = trimmed.match(/^'([^']+)'/)
    if (m) keys.add(m[1])
  }
  return keys
}

/** Keys the native-agent settings SPA writes via PUT /api/env. */
function readSpaPutKeys(): string[] {
  const src = readFileSync(NATIVE_AGENT_TSX, 'utf8')
  const keys = new Set<string>()
  for (const m of src.matchAll(/updates\.(AGIM_[A-Z0-9_]+)\s*=/g)) {
    keys.add(m[1])
  }
  return [...keys].sort()
}

describe('v1.2.127 — ENV_EDITABLE_KEYS allowlist', () => {
  const keys = readAllowedKeys()

  // v1.2.126 search-provider chain + 5 API keys + per-tool caps. The
  // per-tool caps are wired into the pi tool bridge (native path), so
  // they remain live + editable.
  const V126_KEYS = [
    'AGIM_WEB_SEARCH_PROVIDERS',
    'TAVILY_API_KEY', 'BRAVE_API_KEY', 'SERPER_API_KEY',
    'EXA_API_KEY',    'METASO_API_KEY',
    'AGIM_NATIVE_TOOL_RESULT_MAX_CHARS',
    'AGIM_NATIVE_TOOL_TIMEOUT_MS',
  ]

  const STT_KEYS = [
    'AGIM_TRANSCRIBE_PROVIDER',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'AGIM_OPENAI_TRANSCRIBE_MODEL',
    'AGIM_BAIDU_SPEECH_API_KEY',
    'AGIM_BAIDU_SPEECH_SECRET_KEY',
    'AGIM_TENCENT_SECRET_ID',
    'AGIM_TENCENT_SECRET_KEY',
    'AGIM_TENCENT_ASR_ENGINE',
    'AGIM_IFLYTEK_APP_ID',
    'AGIM_IFLYTEK_API_KEY',
    'AGIM_IFLYTEK_API_SECRET',
    'AGIM_WHISPERCPP_BIN',
    'AGIM_WHISPERCPP_MODEL',
    'AGIM_WHISPERCPP_ARGS',
  ]

  // Keys that stay editable: A2A, plan mode, iteration, policy, critic.
  const LIVE_NATIVE_KEYS = [
    // A2A
    'AGIM_A2A_MAX_DEPTH',
    'AGIM_A2A_TIMEOUT_DEFAULT_MS',
    'AGIM_NATIVE_CALL_AGENT_IN_PROCESS',
    'AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN',
    // Plan mode
    'AGIM_NATIVE_PLAN_MODE',
    'AGIM_PLAN_MODE',
    'AGIM_DISABLE_PLAN_MODE',
    // Approval timeout policy (canonical + legacy)
    'AGIM_APPROVAL_ON_TIMEOUT',
    'AGIM_TIMEOUT_DEFAULT',
    // Iteration cap
    'AGIM_NATIVE_AGENT_MAX_ITER',
    'AGIM_NATIVE_AGENT_MAX_TOOL_CALLS',
    // Active AgentHarness wall watchdog
    'AGIM_NATIVE_TURN_TIMEOUT_MS',
    // Policy / role (SPA native-agent form)
    'AGIM_NATIVE_AGENT_ROLE',
    'AGIM_NATIVE_AGENT_MODE',
    'AGIM_NATIVE_AGENT_AUTOALLOW',
    'AGIM_NATIVE_AGENT_DENYLIST',
    // Notification evaluator + heartbeat
    'AGIM_NOTIFICATION_EVALUATOR',
    'AGIM_NOTIFICATION_EVALUATOR_SOURCES',
    'AGIM_HEARTBEAT_ENABLED',
    'AGIM_HEARTBEAT_TICK_INTERVAL_MS',
    'AGIM_HEARTBEAT_DEFAULT_INTERVAL_MIN',
    // Live on pi-native (not only the retired runAgentLoop)
    'AGIM_NATIVE_CRITIC',
    'AGIM_NATIVE_CRITIC_ROLE',
    'AGIM_NATIVE_SEMANTIC_STUCK_LOOP',
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
    'AGIM_NATIVE_COMPACTION',
    'AGIM_CTX_CLEARING',
  ]

  // Knobs that only affected the retired runAgentLoop / old auto-compact
  // path. Must stay off the allowlist so they cannot reappear in SPA Save.
  const REMOVED_DEAD_KEYS = [
    'AGIM_NATIVE_BLANK_RETRY_MAX',
    'AGIM_NATIVE_LENGTH_RECOVERY_MAX',
    'AGIM_NATIVE_COMPACT_TRIGGER_CHARS',
    'AGIM_NATIVE_COMPACT_KEEP_TURNS',
    'AGIM_NATIVE_COMPACT_KEEP_FIRST',
    'AGIM_NATIVE_COMPACT_SUMMARY_CHARS',
    'AGIM_NATIVE_STREAM_PARTIAL',
    'AGIM_NATIVE_FIRSTTOKEN_RETRY_MAX',
    'AGIM_NATIVE_FIRSTTOKEN_RETRY_DELAY_MS',
  ]

  it('keeps every v1.2.126 key', () => {
    for (const k of V126_KEYS) {
      expect(keys.has(k)).toBe(true)
    }
  })

  it('keeps speech-to-text provider keys', () => {
    for (const k of STT_KEYS) {
      expect(keys.has(k)).toBe(true)
    }
  })

  it('keeps the live native-agent keys', () => {
    for (const k of LIVE_NATIVE_KEYS) {
      expect(keys.has(k)).toBe(true)
    }
  })

  it('allowlists every key the native-agent SPA writes on Save', () => {
    const spaKeys = readSpaPutKeys()
    expect(spaKeys.length).toBeGreaterThan(5)
    for (const k of spaKeys) {
      expect(keys.has(k)).toBe(true)
    }
  })

  it('does NOT include retired runAgentLoop-only knobs', () => {
    for (const k of REMOVED_DEAD_KEYS) {
      expect(keys.has(k)).toBe(false)
    }
  })

  it('does NOT include OS-level process keys (allowlist sanity)', () => {
    // Whole point of the allowlist is to refuse anything not listed.
    // These would let an admin hijack the host process.
    expect(keys.has('PATH')).toBe(false)
    expect(keys.has('HOME')).toBe(false)
    expect(keys.has('NODE_OPTIONS')).toBe(false)
    expect(keys.has('LD_PRELOAD')).toBe(false)
    expect(keys.has('LD_LIBRARY_PATH')).toBe(false)
  })
})
