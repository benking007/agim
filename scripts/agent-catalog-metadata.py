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


# Registry: catalog aliases are authoritative; adapter aliases are checked for drift.
path = Path('src/core/registry.ts')
text = path.read_text()
text = replace_once(
    text,
    '  registerAgent(adapter: AgentAdapter): void {',
    '  registerAgent(adapter: AgentAdapter, aliases: readonly string[] = adapter.aliases): void {',
    'registerAgent signature',
)
text = replace_once(
    text,
    '    for (const alias of adapter.aliases) {',
    '    for (const alias of aliases) {',
    'registerAgent aliases',
)
old = """      if (adapter.name !== entry.id) {
        throw new Error(`Agent catalog mismatch: expected ${entry.id}, loaded ${adapter.name}`)
      }
      this.registerAgent(adapter)
"""
new = """      if (adapter.name !== entry.id) {
        throw new Error(`Agent catalog mismatch: expected ${entry.id}, loaded ${adapter.name}`)
      }
      const adapterAliases = [...adapter.aliases].sort()
      const catalogAliases = [...entry.aliases].sort()
      if (JSON.stringify(adapterAliases) !== JSON.stringify(catalogAliases)) {
        throw new Error(
          `Agent catalog alias mismatch for ${entry.id}: ` +
          `catalog=${catalogAliases.join(',')} adapter=${adapterAliases.join(',')}`,
        )
      }
      this.registerAgent(adapter, entry.aliases)
"""
text = replace_once(text, old, new, 'registry catalog validation')
path.write_text(text)


# Onboarding: install guidance and command list are derived from the catalog.
path = Path('src/core/onboarding.ts')
text = path.read_text()
text = replace_once(
    text,
    "import { AGIM_HOME } from './agim-paths.js'\n",
    "import { AGIM_HOME } from './agim-paths.js'\nimport {\n  BUILT_IN_AGENT_CATALOG,\n  getAgentInstallCommand,\n  getBuiltInAgentCatalogEntry,\n} from './agent-catalog.js'\n",
    'onboarding catalog import',
)
if 'export interface AgentInstallHint {' in text:
    text = replace_between(
        text,
        'export interface AgentInstallHint {\n',
        'export interface Config {\n',
        '',
        'remove AgentInstallHint',
    )
if 'const AGENT_PACKAGES:' in text:
    text = replace_between(
        text,
        'const AGENT_PACKAGES: Record<string, AgentInstallHint> = {\n',
        '// ============================================\n// ============================================\n// Agent availability cache',
        '',
        'remove AGENT_PACKAGES',
    )
old_get_hint = """  const getInstallHint = (name: string): string => {
    const hint = AGENT_PACKAGES[name]
    if (!hint) return `npm i -g ${name}`
    if (hint.installCmd) return hint.installCmd
    return `npm i -g ${hint.npmPackage}`
  }
"""
new_get_hint = """  const getInstallHint = (name: string): string =>
    getAgentInstallCommand(name) ?? `Install the ${name} adapter and ensure its CLI is on PATH.`
"""
text = replace_once(text, old_get_hint, new_get_hint, 'format install helper')
not_available_function = """export function formatAgentNotAvailableError(agentName: string): string {
  const entry = getBuiltInAgentCatalogEntry(agentName)
  const installHint = entry?.install.unavailableHint
    ?? getAgentInstallCommand(agentName)
    ?? `Install the ${agentName} adapter and ensure its CLI is on PATH.`
  const alternatives = BUILT_IN_AGENT_CATALOG
    .map((candidate) => {
      const command = candidate.aliases.find((alias) => alias.length <= 4) ?? candidate.id
      return `  /${command} - ${candidate.displayName}`
    })
    .join('\n')

  return `❌ ${agentName} is not installed or not available.\n\n${installHint}\n\nOr try another agent:\n${alternatives}`
}

"""
text = replace_between(
    text,
    'export function formatAgentNotAvailableError(agentName: string): string {\n',
    '// ============================================\n// 4. runMessengerOnboarding',
    not_available_function,
    'not available formatter',
)
path.write_text(text)


# Comments: describe the generic persistence contract rather than deleted columns.
replacements = {
    'src/plugins/agents/antigravity/index.ts': [
        ('it on Session.antigravitySessionId.', 'it under Session.agentSessions.antigravity.'),
        ('`/new` clears antigravitySessionId; the next run starts fresh.',
         '`/new` clears the stored Antigravity session state; the next run starts fresh.'),
    ],
    'src/plugins/agents/codex/index.ts': [
        ('it on the agim Session row (codexSessionId).',
         'it under the generic agim Session.agentSessions map.'),
    ],
    'src/plugins/agents/opencode/adapter.test.ts': [
        ('setOpencodeSessionId\n    // is itself idempotent so this is safe.',
         'setAgentSessionId\n    // is itself idempotent so this is safe.'),
    ],
    'src/plugins/agents/opencode/opencode-http-adapter.ts': [
        ('setOpencodeSessionId', 'setAgentSessionId'),
    ],
    'src/plugins/agents/cursor/index.ts': [
        ('calls `opts.onAgentSessionId(id)` so cli persists it on the agim\n//     Session row.',
         'calls `opts.onAgentSessionId(id)` so the router persists it in the\n//     generic agentSessions map.'),
        ('`/new` clears the agim session row\'s cursor id; next run starts',
         '`/new` clears the stored Cursor session state; the next run starts'),
    ],
}
for filename, pairs in replacements.items():
    path = Path(filename)
    text = path.read_text()
    for old, new in pairs:
        text = replace_once(text, old, new, f'{filename}: {old[:24]}')
    path.write_text(text)


# Architecture test: aliases/install metadata and optional legacy fields.
path = Path('test/unit/agent-session-architecture.test.ts')
text = path.read_text()
old_legacy = """    const legacyFields = BUILT_IN_AGENT_CATALOG.flatMap((entry) => {
      if (!entry.nativeSession) return []
      return [
        entry.nativeSession.legacyIdField,
        ...(entry.nativeSession.legacyPrimedField
          ? [entry.nativeSession.legacyPrimedField]
          : []),
      ]
    })
    expect(new Set(legacyFields).size).toBe(legacyFields.length)
"""
new_legacy = """    const routingNames = BUILT_IN_AGENT_CATALOG.flatMap((entry) => [entry.id, ...entry.aliases])
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
"""
text = replace_once(text, old_legacy, new_legacy, 'catalog uniqueness test')
old_load = """      const adapter = await entry.load()
      expect(adapter.name).toBe(entry.id)
"""
new_load = """      const adapter = await entry.load()
      expect(adapter.name).toBe(entry.id)
      expect([...adapter.aliases].sort()).toEqual([...entry.aliases].sort())
"""
text = replace_once(text, old_load, new_load, 'adapter alias validation test')
old_discovered = """      expect(getAgentNativeSessionPolicy('opencode')?.idMode).toBe('discovered')
      const first = await sessionManager.prepareAgentSession(
"""
new_discovered = """      expect(getAgentNativeSessionPolicy('opencode')?.idMode).toBe('discovered')
      expect(getAgentNativeSessionPolicy('cursor')?.idMode).toBe('discovered')
      const first = await sessionManager.prepareAgentSession(
"""
text = replace_once(text, old_discovered, new_discovered, 'cursor policy test')
path.write_text(text)

print('agent catalog metadata refactor applied')
