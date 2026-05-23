// Plugin registry for messengers and agents

import type { MessengerAdapter, AgentAdapter } from './types.js'
import type { ACPAgentConfig } from '../plugins/agents/acp/types.js'
import { logger as rootLogger } from './logger.js'
import { isGlobalImEnabled, isRemoteAgentEnabled } from './feature-flags.js'

const log = rootLogger.child({ component: 'registry' })

/**
 * Global registry for all adapters
 */
class PluginRegistry {
  private messengers = new Map<string, MessengerAdapter>()
  private agents = new Map<string, AgentAdapter>()
  private agentAliases = new Map<string, string>()

  registerMessenger(adapter: MessengerAdapter): void {
    if (this.messengers.has(adapter.name)) {
      log.warn({ messenger: adapter.name }, `Messenger "${adapter.name}" already registered, overwriting`)
    }
    this.messengers.set(adapter.name, adapter)
  }

  registerAgent(adapter: AgentAdapter): void {
    if (this.agents.has(adapter.name)) {
      log.warn({ agent: adapter.name }, `Agent "${adapter.name}" already registered, overwriting`)
    }
    this.agents.set(adapter.name, adapter)

    // Register aliases
    for (const alias of adapter.aliases) {
      if (this.agentAliases.has(alias)) {
        log.warn({ alias, agent: adapter.name }, `Agent alias "${alias}" already registered, overwriting`)
      }
      this.agentAliases.set(alias, adapter.name)
    }
  }

  getMessenger(name: string): MessengerAdapter | undefined {
    return this.messengers.get(name)
  }

  getAgent(name: string): AgentAdapter | undefined {
    return this.agents.get(name)
  }

  findAgent(nameOrAlias: string): AgentAdapter | undefined {
    // Try exact name first
    const agent = this.agents.get(nameOrAlias)
    if (agent) return agent

    // Try alias
    const realName = this.agentAliases.get(nameOrAlias)
    if (realName) {
      return this.agents.get(realName)
    }

    return undefined
  }

  listMessengers(): string[] {
    return Array.from(this.messengers.keys())
  }

  listAgents(): string[] {
    return Array.from(this.agents.keys())
  }

  /**
   * Load ACP (remote) agents from config. Uses Promise.allSettled
   * for parallel loading so one slow endpoint doesn't block startup.
   *
   * Compliance gate: IMHUB_ENABLE_REMOTE_AGENT must be '1' or the entire
   * call is a no-op. Logged at info level so an operator who flipped
   * config-on-disk without the env flag can see why nothing loaded.
   */
  async loadACPAgents(acpConfigs: ACPAgentConfig[]): Promise<void> {
    if (!isRemoteAgentEnabled()) {
      if (acpConfigs.length > 0) {
        log.info({ event: 'registry.acp.disabled', count: acpConfigs.length },
          'ACP agents in config but remote-agent gate is off; skipping load')
      }
      return
    }
    const enabled = acpConfigs.filter((c) => c.enabled !== false)
    if (enabled.length === 0) return

    const results = await Promise.allSettled(
      enabled.map(async (cfg) => {
        const { ACPAdapter } = await import('../plugins/agents/acp/acp-adapter.js')
        const adapter = new ACPAdapter(cfg)

        const available = await adapter.isAvailable().catch(() => false)
        if (!available) {
          log.warn({ acpAgent: cfg.name, endpoint: cfg.endpoint }, `ACP agent "${cfg.name}" not reachable, skipping`)
          return
        }

        this.registerAgent(adapter)
        log.info({ acpAgent: cfg.name, endpoint: cfg.endpoint }, `Loaded ACP agent: ${cfg.name}`)
      })
    )

    for (const result of results) {
      if (result.status === 'rejected') {
        log.warn({ reason: String(result.reason) }, 'Failed to load ACP agent')
      }
    }
  }

  /**
   * Discover ACP agents via `.well-known/acp` on each base URL, then
   * load every advertised agent through loadACPAgents(). Failures on
   * individual URLs are logged but don't fail the batch.
   *
   * Compliance gate: same IMHUB_ENABLE_REMOTE_AGENT switch — skip the
   * discovery fetch entirely so disabled deployments don't even emit
   * `.well-known/acp` requests on the network.
   */
  async loadDiscoveredACPAgents(baseUrls: string[]): Promise<number> {
    if (!isRemoteAgentEnabled()) {
      if (baseUrls.length > 0) {
        log.info({ event: 'registry.acp.discovery.disabled', count: baseUrls.length },
          'ACP discovery URLs configured but remote-agent gate is off; skipping discovery')
      }
      return 0
    }
    if (!baseUrls.length) return 0
    const { discoverMany } = await import('../plugins/agents/acp/discovery.js')
    const results = await discoverMany(baseUrls)
    const flat: ACPAgentConfig[] = []
    for (const r of results) flat.push(...r.agents)
    if (flat.length === 0) return 0
    await this.loadACPAgents(flat)
    log.info({ baseUrls: baseUrls.length, agents: flat.length },
      'ACP discovery complete')
    return flat.length
  }

  async loadBuiltInPlugins(): Promise<void> {
    // Load built-in messengers. Discord + Telegram are gated by
    // IMHUB_ENABLE_GLOBAL_IM — even if config.json still has a
    // `discord` / `telegram` block, the adapter is never instantiated
    // unless the flag is on. This keeps the runtime in the same shape
    // the UI presents (no zombie outbound connections).
    const { ilinkWeChatAdapter } = await import('../plugins/messengers/wechat/ilink-adapter.js')
    this.registerMessenger(ilinkWeChatAdapter)

    const globalIm = isGlobalImEnabled()
    if (globalIm) {
      const { telegramAdapter } = await import('../plugins/messengers/telegram/telegram-adapter.js')
      this.registerMessenger(telegramAdapter)
    }

    const { feishuAdapter } = await import('../plugins/messengers/feishu/index.js')
    this.registerMessenger(feishuAdapter)

    const { dingtalkAdapter } = await import('../plugins/messengers/dingtalk/index.js')
    this.registerMessenger(dingtalkAdapter)

    if (globalIm) {
      const { discordAdapter } = await import('../plugins/messengers/discord/index.js')
      this.registerMessenger(discordAdapter)
    }

    const { emailAdapter } = await import('../plugins/messengers/email/email-adapter.js')
    this.registerMessenger(emailAdapter)

    // Load built-in agents
    const { claudeCodeAdapter } = await import('../plugins/agents/claude-code/index.js')
    this.registerAgent(claudeCodeAdapter)

    const { codexAdapter } = await import('../plugins/agents/codex/index.js')
    this.registerAgent(codexAdapter)

    // copilot agent removed (low-usage cleanup; see R15 follow-up).
    // If the operator still has `copilot` in config.agents the registry
    // simply won't have a matching name and the existing "agent not
    // available" fallback path takes over.

    const { opencodeAdapter } = await import('../plugins/agents/opencode/index.js')
    this.registerAgent(opencodeAdapter)

    const { antigravityAdapter } = await import('../plugins/agents/antigravity/index.js')
    this.registerAgent(antigravityAdapter)

    // D+ Stage 2 sub-PR #4 — native (in-process LLM) agent. Always
    // registered; isAvailable() reflects whether an LLM backend with
    // role `native-chat` (or `cheap` fallback) is configured. Operators
    // who don't configure llmBackends never see /cc native available.
    const { nativeAgentAdapter } = await import('../plugins/agents/native/index.js')
    this.registerAgent(nativeAgentAdapter)

    log.info({ messengers: this.messengers.size, agents: this.agents.size },
      'Plugin registry initialized')
  }
}

// Singleton registry
export const registry = new PluginRegistry()
