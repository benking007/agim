// Built-in agent catalog — one place for adapter loading, aliases, install
// guidance, operator-facing metadata, and native-session policy.
//
// Adapter implementations still expose runtime metadata for third-party use.
// Registry startup and architecture tests validate that loaded built-ins match
// this catalog; CLI and Web surfaces consume the serializable projection.

import type { AgentAdapter, AgentAdapterKind } from './types.js'

export type AgentSessionIdMode = 'preallocated' | 'discovered'
export type BuiltInAgentScope = 'bridged' | 'agim'
export type BuiltInAgentConfigSection = 'agents' | 'agim'

export type LegacyAgentSessionIdField =
  | 'claudeSessionId'
  | 'opencodeSessionId'
  | 'codexSessionId'
  | 'antigravitySessionId'
  | 'kimiSessionId'
  | 'qoderSessionId'
  | 'piSessionId'
  | 'mimoSessionId'
  | 'copilotSessionId'

export type LegacyAgentSessionPrimedField = 'claudeSessionPrimed'

export interface AgentNativeSessionPolicy {
  /** Whether Agim creates the id before the first turn or captures it from output. */
  idMode: AgentSessionIdMode
  /** Temporary compatibility bridge for session JSON written by older releases. */
  legacyIdField?: LegacyAgentSessionIdField
  /** Optional legacy boolean used by adapters that distinguish create vs resume. */
  legacyPrimedField?: LegacyAgentSessionPrimedField
}

export interface AgentInstallMetadata {
  /** Executable used by availability probes and operator diagnostics. Empty for in-process backends. */
  command: string
  /** Arguments used by the lightweight CLI availability probe. Defaults to `--version`. */
  probeArgs?: readonly string[]
  /** npm package when the canonical installation path is `npm i -g`. */
  npmPackage?: string
  /** Full install guidance when npm is not the only/canonical route. */
  installCommand?: string
  /** Optional expanded explanation shown by the unavailable-agent error. */
  unavailableHint?: string
  /** Whether CLI setup should surface the localized authentication hint for this backend. */
  requiresAuthHint?: boolean
}

export interface BuiltInAgentCatalogEntry {
  /** Canonical registry id. Must equal the loaded adapter's `name`. */
  id: string
  displayName: string
  /** Command aliases used by the registry for slash commands and routing. */
  aliases: readonly string[]
  /** Extra aliases accepted only by `agim config <component>`. */
  configAliases?: readonly string[]
  /** Runtime implementation flavor; validated against the loaded adapter. */
  kind: Exclude<AgentAdapterKind, 'remote'>
  /** Whether the settings surface treats the backend as bridged or as Agim itself. */
  scope: BuiltInAgentScope
  /** Top-level config wizard section opened by the backend's names and aliases. */
  configSection: BuiltInAgentConfigSection
  /** Lower values are preferred when quickstart must choose an available default. */
  readinessPriority: number
  load: () => Promise<AgentAdapter>
  install: AgentInstallMetadata
  /** Present only when the backend has its own resumable conversation id. */
  nativeSession?: AgentNativeSessionPolicy
}

export interface BuiltInAgentSurface {
  id: string
  displayName: string
  aliases: string[]
  configAliases: string[]
  kind: Exclude<AgentAdapterKind, 'remote'>
  scope: BuiltInAgentScope
  configSection: BuiltInAgentConfigSection
  readinessPriority: number
  install: {
    command: string
    probeArgs: string[]
    npmPackage?: string
    installCommand?: string
    requiresAuthHint: boolean
  }
}

export const BUILT_IN_AGENT_CATALOG: readonly BuiltInAgentCatalogEntry[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    aliases: ['cc', 'claude', 'claudecode'],
    kind: 'cli',
    scope: 'bridged',
    configSection: 'agents',
    readinessPriority: 10,
    load: async () => (await import('../plugins/agents/claude-code/index.js')).claudeCodeAdapter,
    install: { command: 'claude', npmPackage: '@anthropic-ai/claude-code' },
    nativeSession: {
      idMode: 'preallocated',
      legacyIdField: 'claudeSessionId',
      legacyPrimedField: 'claudeSessionPrimed',
    },
  },
  {
    id: 'codex',
    displayName: 'Codex',
    aliases: ['cx', 'openai', 'codexcli'],
    kind: 'cli',
    scope: 'bridged',
    configSection: 'agents',
    readinessPriority: 20,
    load: async () => (await import('../plugins/agents/codex/index.js')).codexAdapter,
    install: { command: 'codex', npmPackage: '@openai/codex', requiresAuthHint: true },
    nativeSession: { idMode: 'discovered', legacyIdField: 'codexSessionId' },
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    aliases: ['co', 'gh-copilot', 'github-copilot'],
    kind: 'cli',
    scope: 'bridged',
    configSection: 'agents',
    readinessPriority: 30,
    load: async () => (await import('../plugins/agents/copilot/index.js')).copilotAdapter,
    install: { command: 'copilot', npmPackage: '@github/copilot', requiresAuthHint: true },
    nativeSession: { idMode: 'preallocated', legacyIdField: 'copilotSessionId' },
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    aliases: ['oc', 'opencodeai'],
    kind: 'cli',
    scope: 'bridged',
    configSection: 'agents',
    readinessPriority: 90,
    load: async () => (await import('../plugins/agents/opencode/index.js')).opencodeAdapter,
    install: { command: 'opencode', npmPackage: 'opencode-ai', requiresAuthHint: true },
    nativeSession: { idMode: 'discovered', legacyIdField: 'opencodeSessionId' },
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity',
    aliases: ['agy', 'gemini', 'ag'],
    kind: 'cli',
    scope: 'bridged',
    configSection: 'agents',
    readinessPriority: 100,
    load: async () => (await import('../plugins/agents/antigravity/index.js')).antigravityAdapter,
    install: {
      command: 'agy',
      probeArgs: ['help'],
      installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      unavailableHint: `安装方式:
  curl -fsSL https://antigravity.google/cli/install.sh | bash
然后跑一次 \`agy\` 走 Google 账号 OAuth 完成首次登录。`,
      requiresAuthHint: true,
    },
    nativeSession: { idMode: 'discovered', legacyIdField: 'antigravitySessionId' },
  },
  {
    id: 'kimi-code',
    displayName: 'Kimi Code',
    aliases: ['kimi', 'km'],
    kind: 'cli',
    scope: 'bridged',
    configSection: 'agents',
    readinessPriority: 50,
    load: async () => (await import('../plugins/agents/kimi-code/index.js')).kimiCodeAdapter,
    install: {
      command: 'kimi',
      npmPackage: '@moonshot-ai/kimi-code',
      installCommand: 'curl -fsSL https://www.kimi.com/install.sh | sh  # or: npm install -g @moonshot-ai/kimi-code',
      requiresAuthHint: true,
    },
    nativeSession: { idMode: 'discovered', legacyIdField: 'kimiSessionId' },
  },
  {
    id: 'qoder',
    displayName: 'Qoder',
    aliases: ['qd', 'qodercli'],
    kind: 'cli',
    scope: 'bridged',
    configSection: 'agents',
    readinessPriority: 60,
    load: async () => (await import('../plugins/agents/qoder/index.js')).qoderAdapter,
    install: {
      command: 'qodercli',
      installCommand: 'curl -fsSL https://qoder.com/install | sh',
      requiresAuthHint: true,
    },
    nativeSession: { idMode: 'discovered', legacyIdField: 'qoderSessionId' },
  },
  {
    id: 'pi',
    displayName: 'PI',
    aliases: ['pi-agent'],
    kind: 'cli',
    scope: 'bridged',
    configSection: 'agents',
    readinessPriority: 70,
    load: async () => (await import('../plugins/agents/pi/index.js')).piAdapter,
    install: {
      command: 'pi',
      npmPackage: '@earendil-works/pi-coding-agent',
      installCommand: 'npm install -g @earendil-works/pi-coding-agent',
      requiresAuthHint: true,
    },
    nativeSession: { idMode: 'discovered', legacyIdField: 'piSessionId' },
  },
  {
    id: 'mimo',
    displayName: 'MiMo Code',
    aliases: ['mo', 'mimo-code'],
    kind: 'cli',
    scope: 'bridged',
    configSection: 'agents',
    readinessPriority: 80,
    load: async () => (await import('../plugins/agents/mimo/index.js')).mimoAdapter,
    install: {
      command: 'mimo',
      npmPackage: '@mimo-ai/cli',
      installCommand: 'curl -fsSL https://mimo.xiaomi.com/install | bash  # or: npm install -g @mimo-ai/cli',
      requiresAuthHint: true,
    },
    nativeSession: { idMode: 'discovered', legacyIdField: 'mimoSessionId' },
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    aliases: ['cs', 'cur'],
    kind: 'cli',
    scope: 'bridged',
    configSection: 'agents',
    readinessPriority: 40,
    load: async () => (await import('../plugins/agents/cursor/index.js')).cursorAdapter,
    install: {
      command: 'cursor-agent',
      installCommand: 'Install Cursor CLI, then run `cursor-agent login` — see Cursor CLI documentation.',
      requiresAuthHint: true,
    },
    nativeSession: { idMode: 'discovered' },
  },
  {
    id: 'native',
    displayName: 'Agim Agent',
    aliases: ['agim', 'na', 'llm', 'native-llm'],
    configAliases: ['agim-agent'],
    kind: 'in-process',
    scope: 'agim',
    configSection: 'agim',
    readinessPriority: 0,
    load: async () => (await import('../plugins/agents/pi-native/factory.js')).nativeAgentAdapter,
    install: {
      command: '',
      installCommand: 'Run `agim config` → Agim Agent model APIs (or edit ~/.agim/config.json llmBackends + API key) — see docs/llm-backends.md',
    },
  },
] as const

const BUILT_IN_AGENT_BY_ID = new Map(BUILT_IN_AGENT_CATALOG.map((entry) => [entry.id, entry]))

export const AGENT_READINESS_PRIORITY: readonly string[] = [...BUILT_IN_AGENT_CATALOG]
  .sort((a, b) => a.readinessPriority - b.readinessPriority)
  .map((entry) => entry.id)

export function getBuiltInAgentCatalogEntry(agentName: string): BuiltInAgentCatalogEntry | undefined {
  return BUILT_IN_AGENT_BY_ID.get(agentName)
}

export function getAgentNativeSessionPolicy(agentName: string): AgentNativeSessionPolicy | undefined {
  return getBuiltInAgentCatalogEntry(agentName)?.nativeSession
}

export function getAgentInstallCommand(agentName: string): string | undefined {
  const install = getBuiltInAgentCatalogEntry(agentName)?.install
  if (!install) return undefined
  if (install.installCommand) return install.installCommand
  if (install.npmPackage) return `npm i -g ${install.npmPackage}`
  return undefined
}

/** JSON-safe projection consumed by CLI setup and the Web settings surface. */
export function getBuiltInAgentSurfaces(): BuiltInAgentSurface[] {
  return BUILT_IN_AGENT_CATALOG.map((entry) => ({
    id: entry.id,
    displayName: entry.displayName,
    aliases: [...entry.aliases],
    configAliases: [...(entry.configAliases ?? [])],
    kind: entry.kind,
    scope: entry.scope,
    configSection: entry.configSection,
    readinessPriority: entry.readinessPriority,
    install: {
      command: entry.install.command,
      probeArgs: [...(entry.install.probeArgs ?? ['--version'])],
      ...(entry.install.npmPackage ? { npmPackage: entry.install.npmPackage } : {}),
      ...(entry.install.installCommand ? { installCommand: entry.install.installCommand } : {}),
      requiresAuthHint: entry.install.requiresAuthHint === true,
    },
  }))
}
