// Onboarding module - friendly first-run experience
// Handles messenger config checks, agent availability, and interactive setup

import { createInterface } from 'node:readline'
import { registry, isPlatformBlacklisted } from './registry.js'
import { readConfigObject, updateConfigObject, writeConfigObject } from './config-store.js'

// ============================================
// Types
// ============================================

export interface OnboardingResult {
  needsOnboarding: boolean
  availableMessengers: MessengerInfo[]
  warnings?: string[]
}

export interface MessengerInfo {
  id: string
  displayName: string
  description: string
}

export interface AgentCheckResult {
  available: string[]
  missing: string[]
  allMissing: boolean
}

export interface AgentInstallHint {
  agent: string
  /** Default install path = `npm i -g <npmPackage>`. Empty when the agent
   *  ships outside the npm registry (e.g. Antigravity's curl install) — in
   *  that case set `installCmd` to the canonical one-liner. */
  npmPackage: string
  command: string
  /** Optional override for the install hint string. When set, formatters
   *  use this verbatim instead of synthesising `npm i -g <npmPackage>`. */
  installCmd?: string
}

export interface Config {
  messengers: string[]
  agents: string[]
  defaultAgent: string
  telegram?: { botToken: string; channelId?: string }
  feishu?: { appId: string; appSecret: string; channelId?: string }
  dingtalk?: {
    clientId: string
    clientSecret: string
    channelId?: string
    // Batch 1 (#4) — access policy fields
    dmPolicy?: 'open' | 'pairing' | 'allowlist'
    groupPolicy?: 'open' | 'allowlist' | 'disabled'
    allowFrom?: string[]
    groupAllowFrom?: string[]
    // Batch 1 (#7) — ack-reaction
    ackReaction?: 'off' | 'emoji' | 'kaomoji'
    // Batch 4 (#3) — multi-account / multi-bot. When present, each entry
    // spins up its own DWClient. Top-level fields above act as defaults
    // an account-block can selectively override.
    accounts?: Record<string, {
      name?: string
      clientId?: string
      clientSecret?: string
      dmPolicy?: 'open' | 'pairing' | 'allowlist'
      groupPolicy?: 'open' | 'allowlist' | 'disabled'
      allowFrom?: string[]
      groupAllowFrom?: string[]
      ackReaction?: 'off' | 'emoji' | 'kaomoji'
      enabled?: boolean
    }>
  }
  discord?: { botToken: string; channelId?: string; allowedGuilds?: string[]; allowedChannels?: string[] }
  [key: string]: unknown
}

// ============================================
// Constants
// ============================================

// R12 / 2026-05-22 update — Telegram and Discord are kept in the source
// for AGIM_ENABLE_GLOBAL_IM=1 deployments but hidden from the default
// onboarding flow (mainland-China baseline). DingTalk is added so the
// legacy prompt matches what the modern wizard surfaces.
const ALL_MESSENGERS: MessengerInfo[] = [
  { id: 'wechat-ilink', displayName: 'WeChat', description: 'Scan QR to login' },
  { id: 'feishu', displayName: 'Feishu/Lark', description: 'App ID and Secret' },
  { id: 'dingtalk', displayName: 'DingTalk', description: 'ClientID + ClientSecret (Stream mode)' },
  { id: 'telegram', displayName: 'Telegram', description: 'Bot token from @BotFather' },
  { id: 'discord', displayName: 'Discord', description: 'Bot token from Developer Portal' },
]

function getAvailableMessengers(): MessengerInfo[] {
  const globalSet = process.env.AGIM_ENABLE_GLOBAL_IM === '1'
  // v1.2.69 — AGIM_PLATFORM_BLACKLIST hides platforms from the
  // wizard / web admin entirely. Default is empty (no-op). Layered on
  // top of the GLOBAL_IM filter so an operator can still ban any
  // platform regardless of the global-IM mode.
  const base = globalSet
    ? ALL_MESSENGERS
    : ALL_MESSENGERS.filter((m) => m.id !== 'telegram' && m.id !== 'discord')
  return base.filter((m) => !isPlatformBlacklisted(m.id))
}

const AGENT_PACKAGES: Record<string, AgentInstallHint> = {
  'claude-code': { agent: 'claude-code', npmPackage: '@anthropic-ai/claude-code', command: 'claude' },
  'codex': { agent: 'codex', npmPackage: '@openai/codex', command: 'codex' },
  'copilot': { agent: 'copilot', npmPackage: '@github/copilot', command: 'copilot' },
  'opencode': { agent: 'opencode', npmPackage: 'opencode-ai', command: 'opencode' },
  'antigravity': {
    agent: 'antigravity',
    npmPackage: '',
    command: 'agy',
    // Google's official Antigravity CLI is distributed via an install
    // script, not npm. Surface that one-liner so the user-facing hint
    // doesn't tell people to `npm i -g antigravity` (which would 404
    // or install some unrelated package).
    installCmd: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
  },
  'kimi-code': {
    agent: 'kimi-code',
    npmPackage: '@moonshot-ai/kimi-code',
    command: 'kimi',
    installCmd: 'curl -fsSL https://www.kimi.com/install.sh | sh  # or: npm install -g @moonshot-ai/kimi-code',
  },
  'qoder': {
    agent: 'qoder',
    npmPackage: '',
    command: 'qodercli',
    installCmd: 'curl -fsSL https://qoder.com/install | sh',
  },
  'pi': {
    agent: 'pi',
    npmPackage: '@earendil-works/pi-coding-agent',
    command: 'pi',
    installCmd: 'npm install -g @earendil-works/pi-coding-agent',
  },
  'mimo': {
    agent: 'mimo',
    npmPackage: '@mimo-ai/cli',
    command: 'mimo',
    installCmd: 'curl -fsSL https://mimo.xiaomi.com/install | bash  # or: npm install -g @mimo-ai/cli',
  },
  'cursor': {
    agent: 'cursor',
    npmPackage: '',
    command: 'cursor-agent',
    installCmd: 'curl https://cursor.com/install -fsS | bash',
  },
  // D+ Stage 2 sub-PR #4 — native (in-process LLM) agent. No CLI to
  // install; "availability" means an LLM backend with role native-chat
  // (or cheap fallback) is configured. The hint string steers operators
  // at the right docs page instead of suggesting an npm install.
  'agim': {
    agent: 'agim',
    npmPackage: '',
    command: '',
    installCmd: 'Run `agim config` → Agim Agent model APIs (or edit ~/.agim/config.json llmBackends + API key) — see docs/llm-backends.md',
  },
}

// ============================================
// ============================================
// Agent availability cache (TTL-based)
// ============================================

// ============================================
// Config helpers (extracted for reuse)
// ============================================

export async function loadConfig(): Promise<Config> {
  return await readConfigObject<Config>({
    fallback: {
      messengers: [],
      agents: [],
      defaultAgent: 'agim',
    },
  })
}

export async function saveConfig(config: Config): Promise<void> {
  await writeConfigObject(config)
}

/**
 * Persist only the top-level fields changed between two wizard snapshots.
 * The latest on-disk object is read while holding the cross-process lock, so
 * unrelated Web/CLI updates made while the user was inside a prompt survive.
 */
export async function saveConfigChanges(base: Config, next: Config): Promise<Config> {
  const keys = new Set([...Object.keys(base), ...Object.keys(next)])
  const changed = [...keys].filter((key) =>
    JSON.stringify(base[key]) !== JSON.stringify(next[key]))
  if (changed.length === 0) return next

  const update = await updateConfigObject((current) => {
    const merged: Record<string, unknown> = {
      messengers: [],
      agents: [],
      defaultAgent: 'agim',
      ...current,
    }
    for (const key of changed) {
      if (Object.hasOwn(next, key) && next[key] !== undefined) merged[key] = next[key]
      else delete merged[key]
    }
    return { config: merged, result: undefined }
  }, {
    fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
  })
  return update.config as Config
}

// ============================================
// Readline helper
// ============================================

function createPromptInterface(): ReturnType<typeof createInterface> {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  })
}

async function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim())
    })
  })
}

// ============================================
// 1. checkMessengerConfig (SYNC)
// ============================================

/**
 * Check if messengers are configured.
 * IMPORTANT: This checks the config.messengers array BEFORE any default fill.
 */
export function checkMessengerConfig(config: Config): OnboardingResult {
  if (config.messengers.length === 0) {
    return {
      needsOnboarding: true,
      availableMessengers: getAvailableMessengers(),
    }
  }

  return {
    needsOnboarding: false,
    availableMessengers: [],
    warnings: [],
  }
}

// ============================================
// 2. checkAgentAvailability (ASYNC, TTL-cached)
// ============================================

// Cache with TTL so agent install/uninstall is reflected within 2 minutes
let agentCheckCache: { result: AgentCheckResult; timestamp: number } | null = null
const AGENT_CHECK_CACHE_TTL = 2 * 60 * 1000 // 2 minutes

/** Per-agent cached `isAvailable()` results — fall-through cache for
 * `isAgentAvailableCached` when an agent isn't represented in the bulk
 * snapshot (e.g. registered after the last refresh, or the bulk hasn't
 * run yet). The bulk cache is consulted first; this Map only matters for
 * the fallback probe path. */
const perAgentCache = new Map<string, { ok: boolean; timestamp: number }>()

/**
 * Soft-fail quarantine after a live CLI run proves unusable (login /
 * subscription / provider outage). Survives bulk `--version` probes that
 * would otherwise flip the agent back to "available".
 */
const forcedUnavailable = new Map<string, { until: number; reason: string }>()
const FORCED_UNAVAILABLE_TTL_MS = 5 * 60 * 1000

function forcedUnavailableActive(agentName: string): { reason: string } | null {
  const hit = forcedUnavailable.get(agentName)
  if (!hit) return null
  if (Date.now() >= hit.until) {
    forcedUnavailable.delete(agentName)
    return null
  }
  return { reason: hit.reason }
}

/**
 * Mark a CLI agent unusable for dispatch (auth expiry, subscription, …).
 * Loop / call_agents must not prefer or spawn it until TTL elapses.
 */
export function markAgentUnavailable(
  agentName: string,
  reason = 'unavailable',
  ttlMs = FORCED_UNAVAILABLE_TTL_MS,
): void {
  const name = (agentName || '').trim()
  if (!name) return
  forcedUnavailable.set(name, {
    until: Date.now() + Math.max(1_000, ttlMs),
    reason: reason.trim() || 'unavailable',
  })
  perAgentCache.set(name, { ok: false, timestamp: Date.now() })
  if (agentCheckCache) {
    const { available, missing } = agentCheckCache.result
    agentCheckCache.result = {
      available: available.filter((n) => n !== name),
      missing: missing.includes(name) ? missing : [...missing, name],
      allMissing: available.filter((n) => n !== name).length === 0,
    }
  }
}

/** Reason string while an agent is force-quarantined; undefined if clear. */
export function getAgentUnavailableReason(agentName: string): string | undefined {
  return forcedUnavailableActive(agentName)?.reason
}

/** Heuristic: stderr / outcome text looks like login / subscription failure. */
export function looksLikeAgentAuthFailure(text: string | undefined | null): boolean {
  const t = (text || '').toLowerCase()
  if (!t) return false
  return (
    t.includes('expired')
    || t.includes('过期')
    || t.includes('not logged')
    || t.includes('please login')
    || t.includes('please log in')
    || (t.includes('请运行') && t.includes('login'))
    || t.includes('unauthorized')
    || t.includes('authentication')
    || t.includes('subscription')
    || t.includes('quota')
    || t.includes('payment required')
    || t.includes('账号已过期')
    || t.includes('重新登录')
  )
}

/**
 * Short tool-facing error when call_agent(s) must refuse a dead CLI.
 * Prefer this over the long install-hint banner inside Loop turns.
 */
export function formatAgentDispatchUnavailable(
  agentName: string,
  reason?: string,
): string {
  const detail = (reason || getAgentUnavailableReason(agentName) || '').trim()
  const why = detail
    ? detail
    : 'CLI missing, not ready, login/subscription expired, or provider fault'
  return (
    `agent "${agentName}" is not dispatchable right now (${why}). `
    + `Do NOT assign work to it this turn — pick another registered agent `
    + `(or same-family Agim role/backend), or ask the user to fix ${agentName} `
    + `(install / login / subscription) and retry later.`
  )
}

/**
 * Check which agents are available.
 * Result is cached with a 2-minute TTL.
 */
export async function checkAgentAvailability(): Promise<AgentCheckResult> {
  if (agentCheckCache && Date.now() - agentCheckCache.timestamp < AGENT_CHECK_CACHE_TTL) {
    return agentCheckCache.result
  }
  const agentNames = registry.listAgents()
  const available: string[] = []
  const missing: string[] = []
  for (const name of agentNames) {
    const agent = registry.findAgent(name)
    if (agent) {
      try {
        if (forcedUnavailableActive(name)) {
          missing.push(name)
          perAgentCache.set(name, { ok: false, timestamp: Date.now() })
          continue
        }
        const isAvail = await agent.isAvailable()
        if (isAvail) {
          available.push(name)
        } else {
          missing.push(name)
        }
        perAgentCache.set(name, { ok: isAvail, timestamp: Date.now() })
      } catch {
        missing.push(name)
        perAgentCache.set(name, { ok: false, timestamp: Date.now() })
      }
    }
  }
  const result: AgentCheckResult = {
    available,
    missing,
    allMissing: available.length === 0,
  }
  agentCheckCache = { result, timestamp: Date.now() }
  return result
}

/**
 * Check if a specific agent is available.
 *
 * Uses the bulk cache when present, but falls through to a one-off probe
 * if the agent name isn't represented (e.g. agent registered after the
 * last bulk refresh). The probe result is itself cached for the TTL.
 * Force-quarantine (auth/subscription) always wins over `--version` OK.
 */
export async function isAgentAvailableCached(agentName: string): Promise<boolean> {
  if (forcedUnavailableActive(agentName)) return false

  const bulk = await checkAgentAvailability()
  if (bulk.available.includes(agentName)) return true
  if (bulk.missing.includes(agentName)) return false

  // Not represented in bulk — probe directly with a per-agent cache.
  const cached = perAgentCache.get(agentName)
  if (cached && Date.now() - cached.timestamp < AGENT_CHECK_CACHE_TTL) {
    return cached.ok
  }
  const agent = registry.findAgent(agentName)
  if (!agent) return false
  try {
    const ok = await agent.isAvailable()
    perAgentCache.set(agentName, { ok, timestamp: Date.now() })
    return ok
  } catch {
    perAgentCache.set(agentName, { ok: false, timestamp: Date.now() })
    return false
  }
}

/**
 * Clear the agent availability caches. Useful for tests that change the
 * registry state, and for the future `/router refresh` ops command.
 */
export function clearAgentCache(): void {
  agentCheckCache = null
  perAgentCache.clear()
  forcedUnavailable.clear()
}

// ============================================
// 3. formatAgentInstallHint
// ============================================

/**
 * Generate friendly install message for missing agents
 */
export function formatAgentInstallHint(missing: string[]): string {
  if (missing.length === 0) return ''

  const getInstallHint = (name: string): string => {
    const hint = AGENT_PACKAGES[name]
    if (!hint) return `npm i -g ${name}`
    if (hint.installCmd) return hint.installCmd
    return `npm i -g ${hint.npmPackage}`
  }

  if (missing.length === 1) {
    return `Install ${missing[0]}: ${getInstallHint(missing[0])}`
  }

  const hints = missing.map((name) => `  - ${name}: ${getInstallHint(name)}`)
  return `Install agents:\n${hints.join('\n')}`
}

/**
 * Format error message when agent is not available
 */
export function formatAgentNotAvailableError(agentName: string): string {
  let installHint: string

  if (agentName === 'antigravity') {
    installHint = `安装方式:
  curl -fsSL https://antigravity.google/cli/install.sh | bash
然后跑一次 \`agy\` 走 Google 账号 OAuth 完成首次登录。`
  } else {
    const hint = AGENT_PACKAGES[agentName]
    if (hint?.installCmd) installHint = hint.installCmd
    else installHint = hint ? `npm i -g ${hint.npmPackage}` : `npm i -g ${agentName}`
  }

  return `❌ ${agentName} is not installed or not available.\n\n${installHint}\n\nOr try another agent:\n  /agim - Agim Agent\n  /cc - Claude Code\n  /cx - Codex\n  /co - GitHub Copilot\n  /oc - OpenCode\n  /agy - Antigravity\n  /kimi - Kimi Code\n  /qd - Qoder\n  /pi - PI\n  /mimo - MiMo Code`
}

// ============================================
// 4. runMessengerOnboarding
// ============================================

/**
 * Interactive onboarding flow.
 * Returns updated config on success, null on failure/cancel.
 */
export async function runMessengerOnboarding(config: Config): Promise<Config | null> {
  // Non-interactive fallback — cli.ts handles this branch directly now
  // (web-console-only deployments shouldn't exit). Keep this guard so
  // direct callers of runMessengerOnboarding still get a sane no-op.
  if (!process.stdin.isTTY) {
    console.log('No TTY; skip messenger onboarding. Run interactively:')
    console.log('   agim config wechat')
    console.log('   agim config feishu')
    console.log('   agim config dingtalk')
    return null
  }

  const rl = createPromptInterface()

  try {
    const messengers = getAvailableMessengers()
    while (true) {
      // Show menu
      console.log('\n📱 Let\'s set up a messenger:\n')
      messengers.forEach((m, i) => {
        console.log(`  ${i + 1}. ${m.displayName} - ${m.description}`)
      })
      console.log(`  Q. Quit and configure manually\n`)

      const choice = await prompt(rl, `Select a messenger (1-${messengers.length} or Q): `)

      // Handle quit
      if (choice.toLowerCase() === 'q' || choice === '') {
        console.log('\n❌ Onboarding cancelled.')
        console.log('Run "agim config <messenger>" to configure manually.')
        return null
      }

      const index = parseInt(choice, 10) - 1
      if (index < 0 || index >= messengers.length) {
        console.log(`Invalid choice. Please enter 1-${messengers.length} or Q.`)
        continue
      }

      const selected = messengers[index]

      // Run the config flow
      const result = await configureMessenger(selected.id, config, rl)

      if (result) {
        rl.close()
        return result
      }

      // Config failed - show retry menu
      console.log(`\n❌ Failed to configure ${selected.displayName}.`)
      const retry = await prompt(rl, '[R] Retry, [S] Select different, [Q] Quit: ')

      if (retry.toLowerCase() === 'q') {
        rl.close()
        return null
      } else if (retry.toLowerCase() === 's') {
      }
      // 'r' or anything else = retry same messenger (loop continues)
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    console.error(`\n❌ Onboarding error: ${errMsg}`)
    rl.close()
    return null
  }
}

// ============================================
// Messenger config flows
// ============================================

async function configureMessenger(
  messengerId: string,
  config: Config,
  rl: ReturnType<typeof createInterface>
): Promise<Config | null> {
  switch (messengerId) {
    case 'wechat-ilink':
      return configureWeChat(config, rl)
    case 'telegram':
      return configureTelegram(config, rl)
    case 'feishu':
      return configureFeishu(config, rl)
    case 'discord':
      return configureDiscord(config, rl)
    default:
      console.log(`Unknown messenger: ${messengerId}`)
      return null
  }
}

async function configureWeChat(config: Config, _rl: ReturnType<typeof createInterface>): Promise<Config | null> {
  console.log('\n📱 Configuring WeChat...')
  console.log('Fetching QR code...\n')

  try {
    const { ILinkWeChatAdapter } = await import('../plugins/messengers/wechat/ilink-adapter.js')
    const adapter = new ILinkWeChatAdapter()

    const { qrUrl, qrToken } = await adapter.startQRLogin()

    console.log('📱 Scan this QR code with WeChat:\n')
    console.log(qrUrl)
    console.log('\n')

    const credentials = await adapter.waitForQRLogin(qrToken, (status) => {
      console.log(`[${new Date().toLocaleTimeString()}] ${status}`)
    })

    if (credentials) {
      console.log(`\n✅ Logged in as ${credentials.userId}`)
      console.log(`   Bot ID: ${credentials.accountId}`)

      if (!config.messengers.includes('wechat-ilink')) {
        config.messengers.push('wechat-ilink')
      }

      return config
    } else {
      console.log('\n❌ Login failed or timed out')
      return null
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    console.error(`\n❌ Failed to configure WeChat: ${errMsg}`)
    return null
  }
}

async function configureTelegram(config: Config, rl: ReturnType<typeof createInterface>): Promise<Config | null> {
  console.log('\n📱 Configuring Telegram...')
  console.log('To get a bot token:')
  console.log('1. Open Telegram and search for @BotFather')
  console.log('2. Send /newbot and follow instructions')
  console.log('3. Copy the bot token\n')

  const token = await prompt(rl, 'Enter your bot token: ')

  if (!token) {
    console.log('❌ Bot token is required')
    return null
  }

  const channelId = await prompt(rl, 'Enter channel ID (optional, press Enter for default): ')

  config.telegram = { botToken: token, channelId: channelId || 'default' }
  if (!config.messengers.includes('telegram')) {
    config.messengers.push('telegram')
  }

  console.log('✅ Telegram bot token saved')
  console.log(`   Channel ID: ${config.telegram.channelId}`)

  return config
}

async function configureFeishu(config: Config, rl: ReturnType<typeof createInterface>): Promise<Config | null> {
  console.log('\n📱 Configuring Feishu (WebSocket long polling mode)...')
  console.log('To create a Feishu bot:')
  console.log('1. Go to https://open.feishu.cn/app')
  console.log('2. Create a custom bot app')
  console.log('3. Enable Bot capability')
  console.log('4. Configure event subscriptions (Subscribe to "Receive Message" event)')
  console.log('5. Copy App ID and App Secret\n')

  const appId = await prompt(rl, 'Enter App ID: ')
  const appSecret = await prompt(rl, 'Enter App Secret: ')

  if (!appId || !appSecret) {
    console.log('❌ App ID and App Secret are required')
    return null
  }

  config.feishu = { appId, appSecret }
  if (!config.messengers.includes('feishu')) {
    config.messengers.push('feishu')
  }

  console.log('✅ Feishu bot credentials saved')
  console.log('\n✅ Using WebSocket long polling mode - no webhook configuration needed!')
  console.log('   The bot will automatically connect to Feishu servers.')

  return config
}

async function configureDiscord(config: Config, rl: ReturnType<typeof createInterface>): Promise<Config | null> {
  console.log('\n📱 Configuring Discord...')
  console.log('To create a Discord bot:')
  console.log('1. Go to https://discord.com/developers/applications')
  console.log('2. Click "New Application" and give it a name')
  console.log('3. Go to "Bot" tab and click "Add Bot"')
  console.log('4. IMPORTANT: Enable "MESSAGE CONTENT INTENT" under Privileged Gateway Intents')
  console.log('5. Click "Reset Token" to get your bot token')
  console.log('6. Go to OAuth2 > URL Generator:')
  console.log('   - Scopes: bot')
  console.log('   - Bot Permissions: Send Messages, Read Message History, View Channels')
  console.log('7. Use the generated URL to invite the bot to your server\n')

  const token = await prompt(rl, 'Enter your bot token: ')

  if (!token) {
    console.log('❌ Bot token is required')
    return null
  }

  const channelId = await prompt(rl, 'Enter channel ID (optional, press Enter for default): ')
  const allowedGuilds = await prompt(rl, 'Allowed guild IDs (comma-separated, optional): ')
  const allowedChannels = await prompt(rl, 'Allowed channel IDs (comma-separated, optional): ')

  config.discord = {
    botToken: token,
    channelId: channelId || 'default',
    allowedGuilds: allowedGuilds ? allowedGuilds.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    allowedChannels: allowedChannels ? allowedChannels.split(',').map(s => s.trim()).filter(Boolean) : undefined,
  }
  if (!config.messengers.includes('discord')) {
    config.messengers.push('discord')
  }

  console.log('✅ Discord bot token saved')
  console.log(`   Channel ID: ${config.discord.channelId}`)
  if (config.discord.allowedGuilds?.length) {
    console.log(`   Allowed guilds: ${config.discord.allowedGuilds.join(', ')}`)
  }
  if (config.discord.allowedChannels?.length) {
    console.log(`   Allowed channels: ${config.discord.allowedChannels.join(', ')}`)
  }

  return config
}

// ============================================
// Error message formatter for messenger.start()
// ============================================

/**
 * Format a user-friendly error message for messenger startup failures
 */
export function formatMessengerStartError(messengerName: string, error: unknown): string {
  const errMsg = error instanceof Error ? error.message : String(error)

  // Check for credential/auth errors
  if (errMsg.toLowerCase().includes('credentials') || errMsg.toLowerCase().includes('auth')) {
    const configName = messengerName.replace('-ilink', '')
    return `Run "agim config ${configName}" to reconfigure.`
  }

  // Generic error
  return errMsg
}
