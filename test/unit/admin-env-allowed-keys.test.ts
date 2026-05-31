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

describe('v1.2.127 — ENV_EDITABLE_KEYS allowlist', () => {
  const keys = readAllowedKeys()

  // v1.2.126 search-provider chain + 5 API keys + 4 native caps.
  const V126_KEYS = [
    'IMHUB_WEB_SEARCH_PROVIDERS',
    'TAVILY_API_KEY', 'BRAVE_API_KEY', 'SERPER_API_KEY',
    'EXA_API_KEY',    'METASO_API_KEY',
    'IMHUB_NATIVE_TOOL_RESULT_MAX_CHARS',
    'IMHUB_NATIVE_TOOL_TIMEOUT_MS',
    'IMHUB_NATIVE_BLANK_RETRY_MAX',
    'IMHUB_NATIVE_LENGTH_RECOVERY_MAX',
  ]

  // v1.2.127 — 4 cards × ~14 keys.
  const V127_KEYS = [
    // A2A
    'IMHUB_A2A_MAX_DEPTH',
    'IMHUB_A2A_TIMEOUT_DEFAULT_MS',
    'IMHUB_NATIVE_CALL_AGENT_IN_PROCESS',
    'IMHUB_NATIVE_CALL_AGENT_MAX_PER_TURN',
    // 早停 + 复盘
    'IMHUB_NATIVE_SEMANTIC_STUCK_LOOP',
    'IMHUB_NATIVE_CRITIC',
    'IMHUB_NATIVE_CRITIC_ROLE',
    'IMHUB_NATIVE_PLAN_MODE',
    // Auto-compact
    'IMHUB_NATIVE_COMPACT_TRIGGER_CHARS',
    'IMHUB_NATIVE_COMPACT_KEEP_TURNS',
    'IMHUB_NATIVE_COMPACT_KEEP_FIRST',
    'IMHUB_NATIVE_COMPACT_SUMMARY_CHARS',
    // Stream + iter
    'IMHUB_NATIVE_STREAM_PARTIAL',
    'IMHUB_NATIVE_AGENT_MAX_ITER',
  ]

  it('keeps every v1.2.126 key', () => {
    for (const k of V126_KEYS) {
      expect(keys.has(k)).toBe(true)
    }
  })

  it('adds every v1.2.127 key (4 cards)', () => {
    for (const k of V127_KEYS) {
      expect(keys.has(k)).toBe(true)
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
