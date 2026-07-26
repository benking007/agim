// Plugin registry for messengers and agents

import type { MessengerAdapter, AgentAdapter } from './types.js'
import { logger as rootLogger } from './logger.js'
import { isGlobalImEnabled } from './feature-flags.js'
import { isAgentEnabled } from './live-config.js'

const log = rootLogger.child({ component: 'registry' })

/**
 * Global registry for all adapters
 */
class PluginRegistry {
  private messengers = new Map<string, MessengerAdapter>()
  private agents = new Map<string, AgentAdapter>()
  private agentAliases = new Map<string, string>()

  registerMessenger(adapter: MessengerAdapter): void {
    // v1.2.69 — platform blacklist gate. Operators set
    // AGIM_PLATFORM_BLACKLIST=telegram,discord to hard-refuse
    // registration of specific IM platforms at boot. Matches the
    // adapter's `name`; also matches a few common aliases
    // ('wechat' ⇔ 'wechat-ilink') so operators don't have to know
    // the registry-canonical id. The check runs even if the
    // operator's env file or config still has credentials —
    // explicit blacklist wins.
    if (isPlatformBlacklisted(adapter.name)) {
      log.warn({
        event: 'messenger.blacklisted',
        messenger: adapter.name,
        hint: 'Remove from AGIM_PLATFORM_BLACKLIST to enable.',
      }, `Messenger "${adapter.name}" blocked by AGIM_PLATFORM_BLACKLIST — registration refused`)
      return
    }
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
    if (agent) {
      // v1.2.103 — honour the SPA's enabled-agents toggle. An agent that
      // was registered at boot but later switched off via PUT /api/config
      // should stop being routable on the very next request. Empty / unset
      // enabled-list is back-compat "allow all".
      return isAgentEnabled(agent.name) ? agent : undefined
    }

    // Try alias
    const realName = this.agentAliases.get(nameOrAlias)
    if (realName) {
      const resolved = this.agents.get(realName)
      if (resolved && !isAgentEnabled(resolved.name)) return undefined
      return resolved
    }

    return undefined
  }

  /** Resolve an agent by name or alias without applying the enabled-agent
   *  filter. Use this only for diagnostics/user-facing hints; routing and
   *  intent classification should continue to call findAgent(). */
  findRegisteredAgent(nameOrAlias: string): AgentAdapter | undefined {
    const agent = this.agents.get(nameOrAlias)
    if (agent) return agent

    const realName = this.agentAliases.get(nameOrAlias)
    return realName ? this.agents.get(realName) : undefined
  }

  listMessengers(): string[] {
    return Array.from(this.messengers.keys())
  }

  listAgents(): string[] {
    // v1.2.103 — same enabled-list filter as findAgent. Callers include
    // the intent classifier, /agents handler, and the
    // helper-agent selector — all should reflect the operator's current
    // enable/disable choices without a service restart.
    return Array.from(this.agents.keys()).filter((n) => isAgentEnabled(n))
  }

  /** Visible-for-test escape hatch: list every registered agent regardless
   *  of the enabled-list filter. Used by the SPA's "agent status" probe
   *  that needs to render rows for ALL installed agents (the SPA itself
   *  decides which are enabled visually). */
  listAllAgents(): string[] {
    return Array.from(this.agents.keys())
  }

  async loadBuiltInPlugins(): Promise<void> {
    // Load built-in messengers. Discord + Telegram are gated by
    // AGIM_ENABLE_GLOBAL_IM — even if config.json still has a
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

    const { copilotAdapter } = await import('../plugins/agents/copilot/index.js')
    this.registerAgent(copilotAdapter)

    const { opencodeAdapter } = await import('../plugins/agents/opencode/index.js')
    this.registerAgent(opencodeAdapter)

    const { antigravityAdapter } = await import('../plugins/agents/antigravity/index.js')
    this.registerAgent(antigravityAdapter)

    const { kimiCodeAdapter } = await import('../plugins/agents/kimi-code/index.js')
    this.registerAgent(kimiCodeAdapter)

    const { qoderAdapter } = await import('../plugins/agents/qoder/index.js')
    this.registerAgent(qoderAdapter)

    const { piAdapter } = await import('../plugins/agents/pi/index.js')
    this.registerAgent(piAdapter)

    const { mimoAdapter } = await import('../plugins/agents/mimo/index.js')
    this.registerAgent(mimoAdapter)

    // Cursor (`cursor-agent`) — isAvailable() probes the
    // bin; on boxes without cursor installed the agent shows as unavailable
    // and `/cs` returns the install hint.
    const { cursorAdapter } = await import('../plugins/agents/cursor/index.js')
    this.registerAgent(cursorAdapter)

    // Agim Agent (registry id `native`, UI "Agim Agent"). Implementation:
    // plugins/agents/agim-agent (shared helpers in agim-agent-shared).
    const { nativeAgentAdapter } = await import('../plugins/agents/agim-agent/factory.js')
    this.registerAgent(nativeAgentAdapter)
    log.info({ event: 'registry.native_engine', engine: 'agim-agent' },
      'Agim Agent engine: agim-agent')

    log.info({ messengers: this.messengers.size, agents: this.agents.size },
      'Plugin registry initialized')
  }
}

// Singleton registry
export const registry = new PluginRegistry()

// v1.2.69 — IM platform blacklist. Single source of truth for "is
// this platform allowed to register / appear in the wizard / appear
// in the web admin". Default empty (no blocks).
//
// Common id aliases: 'wechat' matches 'wechat-ilink' (the registry-
// canonical name). Other adapters use their own canonical id verbatim
// (telegram / feishu / dingtalk / discord / email / web). Both sides
// of an alias map to the same effective block.
const PLATFORM_ALIAS_MAP: Record<string, string[]> = {
  'wechat': ['wechat-ilink'],
  'wechat-ilink': ['wechat'],
}

/** Parse AGIM_PLATFORM_BLACKLIST → normalized Set with alias
 *  expansion. Lowercase + trim each entry. Empty list (or unset env)
 *  returns an empty Set. */
export function parsePlatformBlacklist(raw: string | undefined): Set<string> {
  const out = new Set<string>()
  if (!raw) return out
  for (const part of raw.split(',')) {
    const trimmed = part.trim().toLowerCase()
    if (!trimmed) continue
    out.add(trimmed)
    for (const alias of PLATFORM_ALIAS_MAP[trimmed] ?? []) out.add(alias)
  }
  return out
}

/** True iff `platform` is on the AGIM_PLATFORM_BLACKLIST env list.
 *  Re-parses env on every call so a hot env-file update (PUT /api/env)
 *  takes effect on the next adapter init without restart. */
export function isPlatformBlacklisted(platform: string): boolean {
  const list = parsePlatformBlacklist(process.env.AGIM_PLATFORM_BLACKLIST)
  if (list.size === 0) return false
  return list.has(platform.toLowerCase())
}

/** Return the current blacklist as an array for diagnostics / UI. */
export function getPlatformBlacklist(): string[] {
  return Array.from(parsePlatformBlacklist(process.env.AGIM_PLATFORM_BLACKLIST))
}
