// Built-in agent catalog — one place for adapter loading, aliases, install
// guidance, and native-session policy.
//
// Adapter implementations still expose runtime metadata for third-party use.
// Registry startup validates that a loaded built-in matches this catalog, then
// uses the catalog aliases as the routing source of truth.

import type { AgentAdapter } from './types.js'

export type AgentSessionIdMode = 'preallocated' | 'discovered'

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
  /** Executable used by availability probes and operator diagnostics. */
  command: string
  /** npm package when the canonical installation path is `npm i -g`. */
  npmPackage?: string
  /** Full install guidance when npm is not the only/canonical route. */
  installCommand?: string
  /** Optional expanded explanation shown by the unavailable-agent error. */
  unavailableHint?: string
}

export interface BuiltInAgentCatalogEntry {
  /** Canonical registry id. Must equal the loaded adapter's `name`. */
  id: string
  displayName: string
  /** Command aliases used by the registry for slash commands and routing. */
  aliases: readonly string[]
  load: () => Promise<AgentAdapter>
  install: AgentInstallMetadata
  /** Present only when the backend has its own resumable conversation id. */
  nativeSession?: AgentNativeSessionPolicy
}

export const BUILT_IN_AGENT_CATALOG: readonly BuiltInAgentCatalogEntry[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    aliases: ['cc', 'claude', 'claudecode'],
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
    load: async () => (await import('../plugins/agents/codex/index.js')).codexAdapter,
    install: { command: 'codex', npmPackage: '@openai/codex' },
    nativeSession: { idMode: 'discovered', legacyIdField: 'codexSessionId' },
  },
  {
    id: 'copilot',
    displayName: 'GitHub Copilot',
    aliases: ['co', 'gh-copilot', 'github-copilot'],
    load: async () => (await import('../plugins/agents/copilot/index.js')).copilotAdapter,
    install: { command: 'copilot', npmPackage: '@github/copilot' },
    nativeSession: { idMode: 'preallocated', legacyIdField: 'copilotSessionId' },
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    aliases: ['oc', 'opencodeai'],
    load: async () => (await import('../plugins/agents/opencode/index.js')).opencodeAdapter,
    install: { command: 'opencode', npmPackage: 'opencode-ai' },
    nativeSession: { idMode: 'discovered', legacyIdField: 'opencodeSessionId' },
  },
  {
    id: 'antigravity',
    displayName: 'Antigravity',
    aliases: ['agy', 'gemini', 'ag'],
    load: async () => (await import('../plugins/agents/antigravity/index.js')).antigravityAdapter,
    install: {
      command: 'agy',
      installCommand: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
      unavailableHint: `安装方式:
  curl -fsSL https://antigravity.google/cli/install.sh | bash
然后跑一次 \`agy\` 走 Google 账号 OAuth 完成首次登录。`,
    },
    nativeSession: { idMode: 'discovered', legacyIdField: 'antigravitySessionId' },
  },
  {
    id: 'kimi-code',
    displayName: 'Kimi Code',
    aliases: ['kimi', 'km'],
    load: async () => (await import('../plugins/agents/kimi-code/index.js')).kimiCodeAdapter,
    install: {
      command: 'kimi',
      npmPackage: '@moonshot-ai/kimi-code',
      installCommand: 'curl -fsSL https://www.kimi.com/install.sh | sh  # or: npm install -g @moonshot-ai/kimi-code',
    },
    nativeSession: { idMode: 'discovered', legacyIdField: 'kimiSessionId' },
  },
  {
    id: 'qoder',
    displayName: 'Qoder',
    aliases: ['qd', 'qodercli'],
    load: async () => (await import('../plugins/agents/qoder/index.js')).qoderAdapter,
    install: {
      command: 'qodercli',
      installCommand: 'curl -fsSL https://qoder.com/install | sh',
    },
    nativeSession: { idMode: 'discovered', legacyIdField: 'qoderSessionId' },
  },
  {
    id: 'pi',
    displayName: 'PI',
    aliases: ['pi-agent'],
    load: async () => (await import('../plugins/agents/pi/index.js')).piAdapter,
    install: {
      command: 'pi',
      npmPackage: '@earendil-works/pi-coding-agent',
      installCommand: 'npm install -g @earendil-works/pi-coding-agent',
    },
    nativeSession: { idMode: 'discovered', legacyIdField: 'piSessionId' },
  },
  {
    id: 'mimo',
    displayName: 'MiMo Code',
    aliases: ['mo', 'mimo-code'],
    load: async () => (await import('../plugins/agents/mimo/index.js')).mimoAdapter,
    install: {
      command: 'mimo',
      npmPackage: '@mimo-ai/cli',
      installCommand: 'curl -fsSL https://mimo.xiaomi.com/install | bash  # or: npm install -g @mimo-ai/cli',
    },
    nativeSession: { idMode: 'discovered', legacyIdField: 'mimoSessionId' },
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    aliases: ['cs', 'cur'],
    load: async () => (await import('../plugins/agents/cursor/index.js')).cursorAdapter,
    install: {
      command: 'cursor-agent',
      installCommand: 'Install Cursor CLI, then run `cursor-agent login` — see Cursor CLI documentation.',
    },
    nativeSession: { idMode: 'discovered' },
  },
  {
    id: 'native',
    displayName: 'Agim Agent',
    aliases: ['agim', 'na', 'llm', 'native-llm'],
    load: async () => (await import('../plugins/agents/pi-native/factory.js')).nativeAgentAdapter,
    install: {
      command: '',
      installCommand: 'Run `agim config` → Agim Agent model APIs (or edit ~/.agim/config.json llmBackends + API key) — see docs/llm-backends.md',
    },
  },
] as const

const BUILT_IN_AGENT_BY_ID = new Map(BUILT_IN_AGENT_CATALOG.map((entry) => [entry.id, entry]))

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
