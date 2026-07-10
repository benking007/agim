from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


def replace_between(text: str, start_marker: str, end_marker: str, replacement: str, label: str) -> str:
    start = text.find(start_marker)
    if start < 0:
        raise RuntimeError(f'{label}: start marker not found')
    end = text.find(end_marker, start)
    if end < 0:
        raise RuntimeError(f'{label}: end marker not found')
    return text[:start] + replacement + text[end:]


# ---------------------------------------------------------------------------
# Session types
# ---------------------------------------------------------------------------
path = Path('src/core/types.ts')
text = path.read_text()
if 'export interface AgentSessionState {' not in text:
    marker = '/**\n * Session state for a conversation\n'
    insert = """/** Adapter-native resumable conversation state. */
export interface AgentSessionState {
  /** Native CLI / remote backend conversation id. */
  id?: string
  /** True after a preallocated session has been started at least once. */
  primed?: boolean
  /** Reserved for adapter-specific resume metadata that should survive restart. */
  metadata?: Record<string, unknown>
}

"""
    text = replace_once(text, marker, insert + marker, 'AgentSessionState insertion')

legacy_start = '  /** UUID we pre-allocate for the claude-code adapter'
legacy_end = '  /** Plan mode flag — toggled by /plan on / /plan off.'
if legacy_start in text:
    text = replace_between(
        text,
        legacy_start,
        legacy_end,
        """  /** Adapter-native resumable conversations keyed by canonical agent name. */
  agentSessions?: Record<string, AgentSessionState>
""",
        'legacy Session fields',
    )
path.write_text(text)


# ---------------------------------------------------------------------------
# Built-in registry loading
# ---------------------------------------------------------------------------
path = Path('src/core/registry.ts')
text = path.read_text()
if "from './agent-catalog.js'" not in text:
    text = replace_once(
        text,
        "import { isAgentEnabled } from './live-config.js'\n",
        "import { isAgentEnabled } from './live-config.js'\nimport { BUILT_IN_AGENT_CATALOG } from './agent-catalog.js'\n",
        'registry catalog import',
    )
start = '    // Load built-in agents\n'
end = "    log.info({ messengers: this.messengers.size, agents: this.agents.size },\n"
if start in text:
    replacement = """    // Load built-in agents from the catalog so adding a backend no longer
    // requires another hand-written import/register branch in the registry.
    for (const entry of BUILT_IN_AGENT_CATALOG) {
      const adapter = await entry.load()
      if (adapter.name !== entry.id) {
        throw new Error(`Agent catalog mismatch: expected ${entry.id}, loaded ${adapter.name}`)
      }
      this.registerAgent(adapter)
      if (entry.id === 'native') {
        log.info({ event: 'registry.native_engine', engine: 'agim-agent' },
          'native engine: agim-agent')
      }
    }

"""
    text = replace_between(text, start, end, replacement, 'registry built-in block')
path.write_text(text)


# ---------------------------------------------------------------------------
# Session manager persistence and generic API
# ---------------------------------------------------------------------------
path = Path('src/core/session.ts')
text = path.read_text()
text = replace_once(
    text,
    "import { createHash, randomBytes } from 'node:crypto'",
    "import { createHash, randomBytes, randomUUID } from 'node:crypto'",
    'session crypto import',
) if "randomUUID } from 'node:crypto'" not in text else text
if "from './agent-session.js'" not in text:
    text = replace_once(
        text,
        "import { AGIM_HOME } from './agim-paths.js'\n",
        "import { AGIM_HOME } from './agim-paths.js'\nimport { getAgentNativeSessionPolicy } from './agent-catalog.js'\nimport {\n  clearAllAgentSessionStates,\n  getAgentSessionState,\n  migrateLegacyAgentSessionStates,\n  setAgentSessionState,\n  type LegacyAgentSessionMetadata,\n} from './agent-session.js'\n",
        'session helper imports',
    )

old_switch_start = '        claudeSessionId: existing?.claudeSessionId,\n'
old_switch_end = '        planMode: existing?.planMode,\n'
if old_switch_start in text:
    text = replace_between(
        text,
        old_switch_start,
        old_switch_end,
        '        agentSessions: existing?.agentSessions,\n',
        'switchAgent native fields',
    )

setters_start = '  /**\n   * Persist claude-code resumable session bookkeeping'
setters_end = '  /**\n   * Increment the per-session usage roll-up after a successful agent\n'
if setters_start in text:
    generic_methods = """  /** Persist an adapter-native session id. Idempotent for repeated events. */
  async setAgentSessionId(
    platform: string, channelId: string, threadId: string,
    agentName: string, agentSessionId: string,
  ): Promise<Session | undefined> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session) return undefined
      if (getAgentSessionState(session, agentName)?.id === agentSessionId) return session
      setAgentSessionState(session, agentName, { id: agentSessionId })
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
      return session
    })
  }

  /** Mark a preallocated native session as started before invoking the CLI. */
  async markAgentSessionPrimed(
    platform: string, channelId: string, threadId: string, agentName: string,
  ): Promise<void> {
    const key = `${platform}:${channelId}:${threadId}`
    return this.withLock(key, async () => {
      const session = this.sessions.get(key) || await this.loadSession(key)
      if (!session || getAgentSessionState(session, agentName)?.primed) return
      setAgentSessionState(session, agentName, { primed: true })
      session.lastActivity = new Date()
      this.sessions.set(key, session)
      await this.saveSessionMeta(key, session)
    })
  }

  /**
   * Prepare one adapter-native conversation for invocation. The catalog decides
   * whether Agim preallocates an id or waits for the adapter to report one.
   */
  async prepareAgentSession(
    platform: string, channelId: string, threadId: string, agentName: string,
  ): Promise<{ agentSessionId?: string; agentSessionResume?: boolean }> {
    const policy = getAgentNativeSessionPolicy(agentName)
    if (!policy) return {}

    let session = await this.getOrCreateSession(platform, channelId, threadId, agentName)
    const current = getAgentSessionState(session, agentName)
    const hadId = Boolean(current?.id)
    let id = current?.id

    if (!id && policy.idMode === 'preallocated') {
      id = randomUUID()
      session = await this.setAgentSessionId(
        platform, channelId, threadId, agentName, id,
      ) ?? session
    }

    const resume = policy.legacyPrimedField
      ? getAgentSessionState(session, agentName)?.primed === true
      : hadId

    if (policy.legacyPrimedField && !resume) {
      await this.markAgentSessionPrimed(platform, channelId, threadId, agentName)
    }

    return {
      ...(id ? { agentSessionId: id, agentSessionResume: resume } : {}),
    }
  }

"""
    text = replace_between(text, setters_start, setters_end, generic_methods, 'session generic setters')

reset_start = '        // Forget the old per-agent CLI sessions — /new should give a clean slate\n'
reset_end = '        // Plan mode is per-conversation intent'
if reset_start in text:
    text = replace_between(
        text,
        reset_start,
        reset_end,
        """        // Forget every adapter-native session — /new is a clean slate.
        clearAllAgentSessionStates(session)
""",
        'reset agent sessions',
    )

save_start = '        claudeSessionId: session.claudeSessionId,\n'
save_end = '        planMode: session.planMode,\n'
if save_start in text:
    text = replace_between(
        text,
        save_start,
        save_end,
        '        agentSessions: session.agentSessions,\n',
        'save agent sessions',
    )

text = replace_once(
    text,
    "const parsed = JSON.parse(data) as Partial<Session> & { messageCount?: number }",
    "const parsed = JSON.parse(data) as Partial<Session> & LegacyAgentSessionMetadata & { messageCount?: number }",
    'load parsed type',
) if 'LegacyAgentSessionMetadata & { messageCount?: number }' not in text else text

load_start = '        claudeSessionId: parsed.claudeSessionId,\n'
load_end = '        planMode: parsed.planMode,\n'
if load_start in text:
    text = replace_between(
        text,
        load_start,
        load_end,
        '        agentSessions: parsed.agentSessions,\n',
        'load agent sessions',
    )

load_insert_marker = '      // Convert message timestamps from legacy format if present\n'
if 'migrateLegacyAgentSessionStates(session, parsed)' not in text:
    text = replace_once(
        text,
        load_insert_marker,
        "      migrateLegacyAgentSessionStates(session, parsed)\n" + load_insert_marker,
        'legacy migration call',
    )

text = text.replace('claudeSessionId etc.)', 'agentSessions etc.)')
text = text.replace('claudeSessionId, claudeSessionPrimed, usage stats', 'agentSessions and usage stats')
text = text.replace('sticky agent / claudeSessionId', 'sticky agent / agentSessions')
path.write_text(text)


# ---------------------------------------------------------------------------
# CLI invocation preparation
# ---------------------------------------------------------------------------
path = Path('src/cli.ts')
text = path.read_text()
start = '        const stickySession = await sessionManager.getExistingSession(\n'
end = '      }\n    }\n\n    // Inline-job tracking:'
if start in text:
    replacement = """        const prepared = await sessionManager.prepareAgentSession(
          platform, ctx.channelId, message.threadId, resolvedAgent,
        )
        routeCtx.agentSessionId = prepared.agentSessionId
        routeCtx.agentSessionResume = prepared.agentSessionResume
"""
    text = replace_between(text, start, end, replacement, 'cli native session branches')
if 'randomUUID' not in text.replace("import { randomUUID } from 'node:crypto'", ''):
    text = text.replace("import { randomUUID } from 'node:crypto'\n", '')
path.write_text(text)


# ---------------------------------------------------------------------------
# Router persistence callback and subtask preparation
# ---------------------------------------------------------------------------
path = Path('src/core/router.ts')
text = path.read_text()
callback_start = '  const onAgentSessionId = (id: string): void => {\n'
callback_end = '  const onUsage = (delta: { costUsd?: number; tokensInput?: number; tokensOutput?: number }): void => {\n'
if callback_start in text:
    replacement = """  const onAgentSessionId = (id: string): void => {
    void sessionManager.setAgentSessionId(
      ctx.platform, ctx.channelId, storageThreadId, agent.name, id,
    ).catch((err) => ctx.logger.debug({
      err: String(err),
      agent: agent.name,
    }, 'setAgentSessionId failed'))
  }
"""
    text = replace_between(text, callback_start, callback_end, replacement, 'router session callback')

subtask_start = 'export async function prepareSubtaskAgentCallOptions(\n'
subtask_end = '  return { storageThreadId }\n}\n'
if subtask_start in text:
    start_index = text.index(subtask_start)
    end_index = text.index(subtask_end, start_index) + len(subtask_end)
    replacement = """export async function prepareSubtaskAgentCallOptions(
  agentName: string,
  ctx: RouteContext,
  storageThreadId: string,
  subSession: Pick<Session, 'agentSessions'>,
): Promise<AgentCallOptions> {
  // The persisted session manager is authoritative; retain this parameter for
  // call-site compatibility while the subtask API is migrated independently.
  void subSession
  const prepared = await sessionManager.prepareAgentSession(
    ctx.platform, ctx.channelId, storageThreadId, agentName,
  )
  return { storageThreadId, ...prepared }
}
"""
    text = text[:start_index] + replacement + text[end_index:]
if 'randomUUID' not in text.replace("import { randomUUID } from 'node:crypto'", ''):
    text = text.replace("import { randomUUID } from 'node:crypto'\n", '')
path.write_text(text)


# ---------------------------------------------------------------------------
# Router subtask regression test
# ---------------------------------------------------------------------------
path = Path('test/unit/router.test.ts')
text = path.read_text()
old = """    it('passes antigravity conversation id into A2A subtask calls', async () => {
      const callOptions = await prepareSubtaskAgentCallOptions(
        'antigravity',
        makeCtx(),
        'thread-1:sub:42',
        {
          antigravitySessionId: 'agy-conv-1',
        },
      )

      expect(callOptions).toEqual({
        storageThreadId: 'thread-1:sub:42',
        agentSessionId: 'agy-conv-1',
        agentSessionResume: true,
      })
    })
"""
if old in text:
    new = """    it('passes antigravity conversation id into A2A subtask calls', async () => {
      const ctx = makeCtx()
      const storageThreadId = `thread-sub-antigravity-${Date.now()}`
      await sessionManager.getOrCreateSession(
        ctx.platform, ctx.channelId, storageThreadId, 'antigravity',
      )
      await sessionManager.setAgentSessionId(
        ctx.platform, ctx.channelId, storageThreadId, 'antigravity', 'agy-conv-1',
      )
      const subSession = await sessionManager.getExistingSession(
        ctx.platform, ctx.channelId, storageThreadId,
      )
      const callOptions = await prepareSubtaskAgentCallOptions(
        'antigravity', ctx, storageThreadId, subSession!,
      )

      expect(callOptions).toEqual({
        storageThreadId,
        agentSessionId: 'agy-conv-1',
        agentSessionResume: true,
      })
    })
"""
    text = replace_once(text, old, new, 'router antigravity test')
path.write_text(text)


# ---------------------------------------------------------------------------
# Session persistence tests
# ---------------------------------------------------------------------------
path = Path('test/unit/session-real.test.ts')
text = path.read_text()
block_start = '  // Regression for the v2 Phase D promise: claudeSessionId / claudeSessionPrimed\n'
block_end = '\n})\n'
if block_start in text:
    start_index = text.index(block_start)
    end_index = text.rindex(block_end)
    replacement = """  it('agentSessions persist to disk and reload', async () => {
    const k = uniqueKey('agent-session-persist')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'claude-code')
      await sessionManager.setAgentSessionId(
        k.platform, k.channelId, k.threadId, 'claude-code', 'uuid-abc-123',
      )
      await sessionManager.markAgentSessionPrimed(
        k.platform, k.channelId, k.threadId, 'claude-code',
      )

      const metaPath = join(SESSIONS_DIR, `${fileStem(k)}.json`)
      const onDisk = JSON.parse(await readFile(metaPath, 'utf-8'))
      expect(onDisk.agentSessions['claude-code']).toEqual({
        id: 'uuid-abc-123', primed: true,
      })
      expect(onDisk.claudeSessionId).toBeUndefined()

      // @ts-expect-error — reach into the singleton's private map for the test
      sessionManager.sessions.delete(`${k.platform}:${k.channelId}:${k.threadId}`)
      const reloaded = await sessionManager.getExistingSession(k.platform, k.channelId, k.threadId)
      expect(reloaded?.agentSessions?.['claude-code']).toEqual({
        id: 'uuid-abc-123', primed: true,
      })
    } finally {
      await cleanupKey(k)
    }
  })

  it('switchAgent preserves generic native sessions and thread-level fields', async () => {
    const k = uniqueKey('switch-carry')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'claude-code')
      await sessionManager.setAgentSessionId(
        k.platform, k.channelId, k.threadId, 'claude-code', 'uuid-keepme',
      )
      await sessionManager.markAgentSessionPrimed(
        k.platform, k.channelId, k.threadId, 'claude-code',
      )
      await sessionManager.recordUsage(k.platform, k.channelId, k.threadId, {
        costUsd: 0.5, promptChars: 100, responseChars: 200, durationMs: 1000,
      })
      await sessionManager.addMessage(k.platform, k.channelId, k.threadId,
        { role: 'user', content: 'pre-switch', timestamp: new Date() })

      const switched = await sessionManager.switchAgent(k.platform, k.channelId, k.threadId, 'opencode')
      expect(switched.agent).toBe('opencode')
      expect(switched.agentSessions?.['claude-code']).toEqual({
        id: 'uuid-keepme', primed: true,
      })
      expect(switched.usage?.costUsd).toBe(0.5)
      expect(switched.messages[0].content).toBe('pre-switch')

      const onDisk = JSON.parse(await readFile(join(SESSIONS_DIR, `${fileStem(k)}.json`), 'utf-8'))
      expect(onDisk.agentSessions['claude-code']).toEqual({
        id: 'uuid-keepme', primed: true,
      })
    } finally {
      await cleanupKey(k)
    }
  })

  it('discovered session ids persist, are idempotent, and reset cleanly', async () => {
    const k = uniqueKey('opencode-persist')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'opencode')
      const first = await sessionManager.setAgentSessionId(
        k.platform, k.channelId, k.threadId, 'opencode', 'ses_x',
      )
      const same = await sessionManager.setAgentSessionId(
        k.platform, k.channelId, k.threadId, 'opencode', 'ses_x',
      )
      expect(first?.agentSessions?.opencode?.id).toBe('ses_x')
      expect(same?.agentSessions?.opencode?.id).toBe('ses_x')

      const changed = await sessionManager.setAgentSessionId(
        k.platform, k.channelId, k.threadId, 'opencode', 'ses_y',
      )
      expect(changed?.agentSessions?.opencode?.id).toBe('ses_y')

      const switched = await sessionManager.switchAgent(k.platform, k.channelId, k.threadId, 'claude-code')
      expect(switched.agentSessions?.opencode?.id).toBe('ses_y')
      const reset = await sessionManager.resetConversation(k.platform, k.channelId, k.threadId)
      expect(reset?.agentSessions).toBeUndefined()
    } finally {
      await cleanupKey(k)
    }
  })

  it('migrates legacy per-agent metadata into agentSessions', async () => {
    const k = uniqueKey('legacy-agent-session')
    try {
      await sessionManager.getOrCreateSession(k.platform, k.channelId, k.threadId, 'claude-code')
      const metaPath = join(SESSIONS_DIR, `${fileStem(k)}.json`)
      const legacy = JSON.parse(await readFile(metaPath, 'utf-8'))
      delete legacy.agentSessions
      legacy.claudeSessionId = 'legacy-uuid'
      legacy.claudeSessionPrimed = true
      legacy.opencodeSessionId = 'legacy-ses'
      await writeFile(metaPath, JSON.stringify(legacy, null, 2))

      // @ts-expect-error — reach into the singleton's private map for the test
      sessionManager.sessions.delete(`${k.platform}:${k.channelId}:${k.threadId}`)
      const reloaded = await sessionManager.getExistingSession(k.platform, k.channelId, k.threadId)
      expect(reloaded?.agentSessions?.['claude-code']).toEqual({
        id: 'legacy-uuid', primed: true,
      })
      expect(reloaded?.agentSessions?.opencode).toEqual({ id: 'legacy-ses' })

      await sessionManager.recordUsage(k.platform, k.channelId, k.threadId, {
        costUsd: 0, promptChars: 1, responseChars: 1, durationMs: 1,
      })
      const migrated = JSON.parse(await readFile(metaPath, 'utf-8'))
      expect(migrated.agentSessions.opencode.id).toBe('legacy-ses')
      expect(migrated.claudeSessionId).toBeUndefined()
      expect(migrated.opencodeSessionId).toBeUndefined()
    } finally {
      await cleanupKey(k)
    }
  })
"""
    text = text[:start_index] + replacement + text[end_index:]
path.write_text(text)

print('agent session refactor applied')
