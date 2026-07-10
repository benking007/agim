import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { readFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

import {
  BUILT_IN_AGENT_CATALOG,
  getAgentNativeSessionPolicy,
} from '../../src/core/agent-catalog'
import { AGIM_HOME } from '../../src/core/agim-paths'
import {
  formatAgentInstallHint,
  formatAgentNotAvailableError,
} from '../../src/core/onboarding'
import { sessionManager } from '../../src/core/session'

const SESSIONS_DIR = join(AGIM_HOME, 'sessions')
const LEGACY_RUNTIME_PATTERN = /(?:claude|opencode|codex|antigravity|kimi|qoder|pi|mimo|copilot)Session(?:Id|Primed)|set(?:Claude|Opencode|Codex|Antigravity|Kimi|Qoder|Pi|Mimo|Copilot)Session/

function uniqueKey(prefix: string): { platform: string; channelId: string; threadId: string } {
  const id = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return { platform: 'test', channelId: `ch-${id}`, threadId: `t-${id}` }
}

function sanitize(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, (char) =>
    createHash('sha256').update(char).digest('hex').slice(0, 8))
}

function stripTypeScriptComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
}

async function cleanupKey(key: { platform: string; channelId: string; threadId: string }): Promise<void> {
  const cacheKey = `${key.platform}:${key.channelId}:${key.threadId}`
  // @ts-expect-error — white-box cleanup of the singleton cache for isolation.
  sessionManager.sessions.delete(cacheKey)
  if (!existsSync(SESSIONS_DIR)) return
  const stem = sanitize(cacheKey)
  for (const name of readdirSync(SESSIONS_DIR)) {
    if (!name.startsWith(stem)) continue
    try { await unlink(join(SESSIONS_DIR, name)) } catch { /* already removed */ }
  }
}

describe('agent catalog', () => {
  it('has unique canonical ids and legacy migration fields', () => {
    const ids = BUILT_IN_AGENT_CATALOG.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)

    const routingNames = BUILT_IN_AGENT_CATALOG.flatMap((entry) => [entry.id, ...entry.aliases])
    expect(new Set(routingNames).size).toBe(routingNames.length)

    const legacyFields = BUILT_IN_AGENT_CATALOG.flatMap((entry) => {
      if (!entry.nativeSession) return []
      return [
        ...(entry.nativeSession.legacyIdField
          ? [entry.nativeSession.legacyIdField]
          : []),
        ...(entry.nativeSession.legacyPrimedField
          ? [entry.nativeSession.legacyPrimedField]
          : []),
      ]
    })
    expect(new Set(legacyFields).size).toBe(legacyFields.length)
    expect(BUILT_IN_AGENT_CATALOG.every((entry) => entry.displayName.length > 0)).toBe(true)
    expect(BUILT_IN_AGENT_CATALOG.every((entry) => entry.install.command !== undefined)).toBe(true)
  })

  it('loads adapters whose runtime names match the catalog ids', async () => {
    for (const entry of BUILT_IN_AGENT_CATALOG) {
      const adapter = await entry.load()
      expect(adapter.name).toBe(entry.id)
      expect([...adapter.aliases].sort()).toEqual([...entry.aliases].sort())
    }
  })

  it('derives install guidance and command alternatives from the catalog', () => {
    expect(formatAgentInstallHint(['codex'])).toBe(
      'Install codex: npm i -g @openai/codex',
    )
    const cursorError = formatAgentNotAvailableError('cursor')
    expect(cursorError).toContain('Install Cursor CLI')
    expect(cursorError).toContain('/cs - Cursor')
    expect(formatAgentNotAvailableError('antigravity')).toContain(
      'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    )
  })
})

describe('generic adapter-native sessions', () => {
  it('preallocates once and resumes on the second Claude invocation', async () => {
    const key = uniqueKey('preallocated')
    try {
      const first = await sessionManager.prepareAgentSession(
        key.platform, key.channelId, key.threadId, 'claude-code',
      )
      expect(first.agentSessionId).toBeString()
      expect(first.agentSessionResume).toBe(false)

      const second = await sessionManager.prepareAgentSession(
        key.platform, key.channelId, key.threadId, 'claude-code',
      )
      expect(second).toEqual({
        agentSessionId: first.agentSessionId,
        agentSessionResume: true,
      })

      const session = await sessionManager.getExistingSession(
        key.platform, key.channelId, key.threadId,
      )
      expect(session?.agentSessions?.['claude-code']).toEqual({
        id: first.agentSessionId,
        primed: true,
      })
    } finally {
      await cleanupKey(key)
    }
  })

  it('waits for discovered ids and resumes after the adapter reports one', async () => {
    const key = uniqueKey('discovered')
    try {
      expect(getAgentNativeSessionPolicy('opencode')?.idMode).toBe('discovered')
      const first = await sessionManager.prepareAgentSession(
        key.platform, key.channelId, key.threadId, 'opencode',
      )
      expect(first).toEqual({})

      await sessionManager.setAgentSessionId(
        key.platform, key.channelId, key.threadId, 'opencode', 'ses_arch_test',
      )
      const second = await sessionManager.prepareAgentSession(
        key.platform, key.channelId, key.threadId, 'opencode',
      )
      expect(second).toEqual({
        agentSessionId: 'ses_arch_test',
        agentSessionResume: true,
      })
    } finally {
      await cleanupKey(key)
    }
  })

  it('persists and resumes Cursor session ids reported by the adapter', async () => {
    const key = uniqueKey('cursor-discovered')
    try {
      expect(getAgentNativeSessionPolicy('cursor')?.idMode).toBe('discovered')
      expect(await sessionManager.prepareAgentSession(
        key.platform, key.channelId, key.threadId, 'cursor',
      )).toEqual({})

      await sessionManager.setAgentSessionId(
        key.platform, key.channelId, key.threadId, 'cursor', 'cursor-chat-1',
      )
      expect(await sessionManager.prepareAgentSession(
        key.platform, key.channelId, key.threadId, 'cursor',
      )).toEqual({
        agentSessionId: 'cursor-chat-1',
        agentSessionResume: true,
      })

      const session = await sessionManager.getExistingSession(
        key.platform, key.channelId, key.threadId,
      )
      expect(session?.agentSessions?.cursor).toEqual({ id: 'cursor-chat-1' })
    } finally {
      await cleanupKey(key)
    }
  })
})

describe('agent-session architecture boundary', () => {
  it('keeps legacy per-agent fields out of central runtime modules', async () => {
    const paths = [
      'src/cli.ts',
      'src/core/router.ts',
      'src/core/session.ts',
      'src/core/types.ts',
    ]
    for (const path of paths) {
      const source = stripTypeScriptComments(await readFile(path, 'utf-8'))
      expect(source.match(LEGACY_RUNTIME_PATTERN), `${path} reintroduced legacy session coupling`).toBeNull()
    }
  })

  it('keeps built-in adapter imports in the catalog rather than the registry', async () => {
    const registrySource = await readFile('src/core/registry.ts', 'utf-8')
    expect(registrySource).not.toMatch(/plugins\/agents\/(?:claude-code|codex|copilot|opencode|antigravity|kimi-code|qoder|pi|mimo|cursor|pi-native)/)
  })
})
