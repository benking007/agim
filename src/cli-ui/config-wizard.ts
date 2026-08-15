// cli-ui/config-wizard.ts — interactive `agim config` flow.
//
// Top-level menu focuses on first-run essentials:
//   1. Messengers     — list-of-channels; each opens its own sub-menu
//                       (WeChat QR scan / Telegram & Feishu & Discord
//                        credential prompts / Email toggle)
//   2. Agents         — list-of-agents with live CLI install detection;
//                       per-agent sub-menu lets you enable/disable, see
//                       install / auth instructions, set as default
//   3. Agim Agent API — model API management (delegates to setup-llm)
//   4. IM Admins      — add/remove by picking known IM identities
//   5. Web port       — web console port
// Advanced sections (SMTP / Baidu) remain available below.
//
// Design rule: every sub-menu has a ← Back entry. The wizard never
// requires Ctrl-C to escape (first-time users don't know it works).
//
// Edits mostly land in the in-memory Config object until
// "Done — save and exit". Exceptions:
//   - SMTP / Baidu write env keys immediately.
//   - Agim Agent API section delegates to setup-llm (writes config+secrets immediately).
//   - IM admins are stored in a separate admin registry file immediately.

import { crossSpawn } from '../utils/cross-platform.js'
import {
  menu,
  inputText,
  inputSecret,
  BACK,
  UserAbortError,
} from './prompts.js'
import { t, type Lang, type Key } from './i18n.js'
import { loadConfig, saveConfigChanges, type Config } from '../core/onboarding.js'
import { describeSecretSource } from '../core/llm/secrets.js'
import { CONFIG_DIR } from './paths.js'
import { ENV_FILE, readEffectiveEnv, updateEnvFile, unsetEnvKey, hasProcessEnvOverride } from './env-file.js'
import { isGlobalImEnabled } from '../core/feature-flags.js'
import { listAdmins, listKnownImUsers, promoteAdmin, revokeAdmin } from '../core/admin-allowlist.js'

/** Probe whether a CLI command exists on PATH. Defaults to the `--version`
 *  spawn check the legacy `config <agent>` flow used. Resolves quickly:
 *  most install probes finish in <200ms, missing binaries return
 *  ENOENT immediately. */
function cliAvailable(cmd: string, args: string[] = ['--version']): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = crossSpawn(cmd, args, { stdio: 'ignore' })
    proc.on('close', (code) => resolve(code === 0))
    proc.on('error', () => resolve(false))
  })
}

type Section = 'messengers' | 'agents' | 'agim' | 'admins' | 'web' | 'smtp' | 'baidu' | 'done'
export type ConfigSection = Exclude<Section, 'done'>

export interface ConfigWizardOptions {
  /** Jump directly into one section; used by legacy `agim config <name>` shortcuts. */
  initialSection?: ConfigSection
  /** Return after the initial section instead of showing the full menu. */
  initialOnly?: boolean
  /** The original shortcut the user typed, for a short compatibility note. */
  shortcutLabel?: string
}

const CONFIG_COMPONENT_SECTIONS: Record<string, ConfigSection> = {
  messengers: 'messengers',
  messenger: 'messengers',
  im: 'messengers',
  wechat: 'messengers',
  'wechat-ilink': 'messengers',
  feishu: 'messengers',
  lark: 'messengers',
  dingtalk: 'messengers',
  telegram: 'messengers',
  discord: 'messengers',
  email: 'messengers',

  agents: 'agents',
  agentcli: 'agents',
  claude: 'agents',
  'claude-code': 'agents',
  codex: 'agents',
  copilot: 'agents',
  co: 'agents',
  'gh-copilot': 'agents',
  'github-copilot': 'agents',
  opencode: 'agents',
  antigravity: 'agents',
  agy: 'agents',
  gemini: 'agents',
  ag: 'agents',
  cursor: 'agents',
  kimi: 'agents',
  'kimi-code': 'agents',
  qoder: 'agents',
  qd: 'agents',
  qodercli: 'agents',
  pi: 'agents',
  'pi-agent': 'agents',
  mimo: 'agents',
  mo: 'agents',
  'mimo-code': 'agents',

  agim: 'agim',
  native: 'agim',
  llm: 'agim',
  'agim-agent': 'agim',

  admins: 'admins',
  admin: 'admins',

  web: 'web',
  smtp: 'smtp',
  baidu: 'baidu',
}

export function sectionForConfigComponent(component: string): ConfigSection | null {
  const key = component.trim().toLowerCase().replace(/_/g, '-')
  return CONFIG_COMPONENT_SECTIONS[key] ?? null
}

async function runConfigSection(lang: Lang, picked: ConfigSection, config: Config): Promise<Config> {
  if (picked === 'messengers') return sectionMessengers(lang, config)
  if (picked === 'agents') return sectionAgents(lang, config)
  if (picked === 'agim') {
    await sectionAgimAgent(lang)
    // setup-llm mutates ~/.agim/config.json directly; reload so the
    // final wizard save never clobbers those updates.
    return loadConfig()
  }
  if (picked === 'admins') {
    await sectionAdmins(lang)
    return config
  }
  if (picked === 'web') return sectionWeb(lang, config)
  if (picked === 'smtp') {
    await sectionSmtp(lang)
    return config
  }
  if (picked === 'baidu') {
    await sectionBaidu(lang)
    return config
  }
  return config
}

export async function runConfigWizard(lang: Lang, opts: ConfigWizardOptions = {}): Promise<void> {
  try {
    const { purgeRetiredAcpResidue } = await import('./retire-acp-residue.js')
    await purgeRetiredAcpResidue()
  } catch { /* best-effort */ }
  let config = await loadConfig()
  const initialConfig = structuredClone(config)
  console.log()
  console.log(t(lang, 'config.title'))
  console.log(t(lang, 'config.subtitle'))
  console.log()

  if (opts.initialSection) {
    if (opts.shortcutLabel) {
      console.log(t(lang, 'config.shortcut.redirect', {
        shortcut: `agim config ${opts.shortcutLabel}`,
        section: t(lang, (`config.section.${opts.initialSection}`) as Key),
      }))
      console.log()
    }
    try {
      config = await runConfigSection(lang, opts.initialSection, config)
    } catch (err) {
      if (err instanceof UserAbortError) return
      throw err
    }
    if (opts.initialOnly) {
      config = await saveConfigChanges(initialConfig, config)
      console.log()
      console.log(t(lang, 'config.saved', { file: `${CONFIG_DIR}/config.json` }))
      const { offerServiceStart } = await import('./cmd-handlers.js')
      await offerServiceStart(lang)
      return
    }
  }

  while (true) {
    let picked: Section | typeof BACK
    try {
      const sectionChoices: Array<{ value: Section; name: string; separatorBefore?: boolean }> = [
        { value: 'messengers', name: t(lang, 'config.section.messengers') },
        { value: 'agents', name: t(lang, 'config.section.agents') },
        { value: 'agim', name: t(lang, 'config.section.agim') },
        { value: 'admins', name: t(lang, 'config.section.admins') },
        { value: 'web', name: t(lang, 'config.section.web') },
      ]
      sectionChoices.push(
        { value: 'smtp', name: t(lang, 'config.section.smtp'), separatorBefore: true },
        { value: 'baidu', name: t(lang, 'config.section.baidu') },
        { value: 'done', name: t(lang, 'config.section.done'), separatorBefore: true },
      )
      picked = (await menu<Section>({
        lang,
        message: t(lang, 'menu.subtitle'),
        choices: sectionChoices,
      })) as Section | typeof BACK
    } catch (err) {
      if (err instanceof UserAbortError) return
      throw err
    }
    if (picked === BACK || picked === 'done') break

    try {
      config = await runConfigSection(lang, picked, config)
    } catch (err) {
      if (err instanceof UserAbortError) continue // Ctrl-C inside a section → bounce back to the top menu
      throw err
    }
  }

  config = await saveConfigChanges(initialConfig, config)
  console.log()
  console.log(t(lang, 'config.saved', { file: `${CONFIG_DIR}/config.json` }))

  // Right after save, offer to start (or restart) the service so first-
  // time users don't fall off a "what now?" cliff. Lazy import keeps the
  // service / systemd machinery out of `--help` startup.
  const { offerServiceStart } = await import('./cmd-handlers.js')
  await offerServiceStart(lang)
}

// ─── messengers section ────────────────────────────────────────────────
//
// Top-level "list" menu shows every supported messenger with its current
// status. Picking one opens a sub-menu that does the *actual* component
// configuration: scan QR for WeChat, prompt for token+channel for
// Telegram, app id+secret for Feishu, etc. This mirrors the legacy
// `agim config <component>` flows — checkbox-only selection wasn't
// enough because each messenger needs different credentials.

type MessengerId = 'wechat-ilink' | 'telegram' | 'feishu' | 'dingtalk' | 'discord' | 'email'

interface MessengerSpec {
  id: MessengerId
  labelKey: Key
  /** Does this entry have its own credentials object? Email/WeChat don't
   *  store credentials in config.json (WeChat keeps a separate token file;
   *  email rides on SMTP). Telegram/Feishu/DingTalk/Discord do. */
  hasCreds: boolean
}

const ALL_MESSENGER_SPECS: MessengerSpec[] = [
  { id: 'wechat-ilink', labelKey: 'messengers.label.wechat',   hasCreds: false },
  { id: 'telegram',     labelKey: 'messengers.label.telegram', hasCreds: true  },
  { id: 'feishu',       labelKey: 'messengers.label.feishu',   hasCreds: true  },
  { id: 'dingtalk',     labelKey: 'messengers.label.dingtalk', hasCreds: true  },
  { id: 'discord',      labelKey: 'messengers.label.discord',  hasCreds: true  },
  { id: 'email',        labelKey: 'messengers.label.email',    hasCreds: false },
]

// Visible subset — compliance gate via feature-flags.ts. Discord +
// Telegram are filtered out unless AGIM_ENABLE_GLOBAL_IM=1. Resolved
// fresh each access so an env-file edit during the wizard takes effect
// on the next iteration of the menu loop.
function visibleMessengerSpecs(): MessengerSpec[] {
  if (isGlobalImEnabled()) return ALL_MESSENGER_SPECS
  return ALL_MESSENGER_SPECS.filter((s) => s.id !== 'discord' && s.id !== 'telegram')
}

/** Return the localized one-line status (enabled / enabled-no-creds /
 *  not configured) for a messenger. Used in the top-level list. */
function messengerStatus(lang: Lang, spec: MessengerSpec, cfg: Config): string {
  const enabled = (cfg.messengers || []).includes(spec.id)
  if (!enabled) return t(lang, 'messengers.status.disabled')
  if (spec.id === 'telegram' && !cfg.telegram?.botToken) {
    return t(lang, 'messengers.status.enabled_no_creds')
  }
  if (spec.id === 'feishu' && !(cfg.feishu?.appId && cfg.feishu?.appSecret)) {
    return t(lang, 'messengers.status.enabled_no_creds')
  }
  if (spec.id === 'dingtalk' && !(cfg.dingtalk?.clientId && cfg.dingtalk?.clientSecret)) {
    return t(lang, 'messengers.status.enabled_no_creds')
  }
  if (spec.id === 'discord' && !cfg.discord?.botToken) {
    return t(lang, 'messengers.status.enabled_no_creds')
  }
  return t(lang, 'messengers.status.enabled')
}

async function sectionMessengers(lang: Lang, cfg: Config): Promise<Config> {
  let config = cfg
  while (true) {
    console.log()
    console.log(t(lang, 'messengers.title'))
    console.log(t(lang, 'messengers.subtitle'))
    if (!isGlobalImEnabled()) {
      console.log(t(lang, 'messengers.global_im_hidden'))
    }
    console.log()
    const specs = visibleMessengerSpecs()
    const choices = specs.map(spec => ({
      value: spec.id,
      name: t(lang, 'messengers.row', {
        label: t(lang, spec.labelKey),
        status: messengerStatus(lang, spec, config),
      }),
    }))
    const picked = await menu<MessengerId>({
      lang,
      message: t(lang, 'menu.subtitle'),
      choices,
      back: 'messengers.action.back',
    })
    if (picked === BACK) return config
    const spec = specs.find(s => s.id === picked)
    if (!spec) continue
    config = await messengerSubMenu(lang, config, spec)
  }
}

/** Per-messenger sub-menu: shows current state, lets user configure,
 *  re-configure, or remove (and for email just enable/disable). All
 *  paths land back here so user can keep editing; ← Back returns to the
 *  list above. */
async function messengerSubMenu(lang: Lang, cfg: Config, spec: MessengerSpec): Promise<Config> {
  let config = cfg
  while (true) {
    const enabled = (config.messengers || []).includes(spec.id)
    console.log()
    console.log(`${t(lang, spec.labelKey)} — ${messengerStatus(lang, spec, config)}`)
    console.log()

    const choices: Array<{ value: string; name: string }> = []

    if (spec.id === 'email') {
      // Email is just a toggle — SMTP creds live in env file, not config.
      if (!enabled) {
        choices.push({ value: 'enable_email', name: t(lang, 'messengers.action.enable_email') })
      } else {
        choices.push({ value: 'disable_email', name: t(lang, 'messengers.action.disable_email') })
      }
    } else if (spec.id === 'wechat-ilink') {
      // WeChat: configure = scan QR.
      choices.push({
        value: 'configure',
        name: enabled
          ? t(lang, 'messengers.action.reconfigure')
          : t(lang, 'messengers.action.configure'),
      })
      if (enabled) {
        choices.push({ value: 'remove', name: t(lang, 'messengers.action.remove') })
      }
    } else {
      // Telegram / Feishu / Discord — prompt for credentials.
      choices.push({
        value: 'configure',
        name: enabled
          ? t(lang, 'messengers.action.reconfigure')
          : t(lang, 'messengers.action.configure'),
      })
      if (enabled) {
        choices.push({ value: 'remove', name: t(lang, 'messengers.action.remove') })
      }
    }

    const action = await menu<string>({
      lang,
      message: t(lang, 'menu.subtitle'),
      choices,
      back: 'messengers.action.back',
    })
    if (action === BACK) return config

    try {
      if (action === 'enable_email' || action === 'disable_email') {
        config = toggleEmail(config, action === 'enable_email')
        if (action === 'enable_email') {
          console.log(t(lang, 'messengers.smtp_hint'))
          console.log(t(lang, 'messengers.enabled', { label: t(lang, spec.labelKey) }))
        } else {
          console.log(t(lang, 'messengers.removed', { label: t(lang, spec.labelKey) }))
        }
      } else if (action === 'remove') {
        config = removeMessenger(config, spec.id)
        console.log(t(lang, 'messengers.removed', { label: t(lang, spec.labelKey) }))
      } else if (action === 'configure') {
        if (spec.id === 'wechat-ilink') config = await configureWechat(lang, config)
        else if (spec.id === 'telegram') config = await configureTelegram(lang, config)
        else if (spec.id === 'feishu')   config = await configureFeishu(lang, config)
        else if (spec.id === 'dingtalk') config = await configureDingtalk(lang, config)
        else if (spec.id === 'discord')  config = await configureDiscord(lang, config)
      }
    } catch (err) {
      if (err instanceof UserAbortError) continue // Ctrl-C inside a sub-flow → bounce back to this menu
      throw err
    }
  }
}

function removeMessenger(cfg: Config, id: MessengerId): Config {
  const messengers = (cfg.messengers || []).filter(m => m !== id)
  const next: Config = { ...cfg, messengers }
  if (id === 'telegram') delete next.telegram
  if (id === 'feishu')   delete next.feishu
  if (id === 'dingtalk') delete next.dingtalk
  if (id === 'discord')  delete next.discord
  return next
}

function toggleEmail(cfg: Config, enable: boolean): Config {
  const current = new Set(cfg.messengers || [])
  if (enable) current.add('email')
  else        current.delete('email')
  return { ...cfg, messengers: Array.from(current) }
}

async function configureWechat(lang: Lang, cfg: Config): Promise<Config> {
  console.log(t(lang, 'wechat.fetching'))
  const { ILinkWeChatAdapter } = await import('../plugins/messengers/wechat/ilink-adapter.js')
  const adapter = new ILinkWeChatAdapter()
  try {
    const { qrUrl, qrToken } = await adapter.startQRLogin()
    console.log()
    console.log(t(lang, 'wechat.scan'))
    console.log(qrUrl)
    console.log()
    console.log(t(lang, 'wechat.waiting'))
    const credentials = await adapter.waitForQRLogin(qrToken, (status) => {
      console.log(`[${new Date().toLocaleTimeString()}] ${status}`)
    })
    if (!credentials) {
      console.log(t(lang, 'wechat.failed'))
      return cfg
    }
    console.log(t(lang, 'wechat.logged_in', { user: credentials.userId ?? '', bot: credentials.accountId ?? '' }))
    const messengers = new Set(cfg.messengers || [])
    messengers.add('wechat-ilink')
    return { ...cfg, messengers: Array.from(messengers) }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`❌ ${msg}`)
    return cfg
  }
}

/** Mask a secret so we can show "(current: ...XYZ)" without leaking the
 *  whole token. Keeps the last 4 chars; pads with • for the prefix so the
 *  visible chunk looks roughly the right shape. */
function maskSecret(s: string): string {
  if (!s) return '(empty)'
  if (s.length <= 6) return '•'.repeat(s.length)
  return '•'.repeat(Math.min(8, s.length - 4)) + s.slice(-4)
}

async function configureTelegram(lang: Lang, cfg: Config): Promise<Config> {
  console.log()
  console.log(t(lang, 'tg.docs'))
  console.log()
  const current = cfg.telegram
  const tokenLabel = current?.botToken
    ? t(lang, 'tg.field.token_keep', { hint: maskSecret(current.botToken) })
    : t(lang, 'tg.field.token')
  const tokenIn = await inputSecret({
    message: tokenLabel,
    required: !current?.botToken,
  })
  const token = tokenIn || current?.botToken || ''
  const channelId = await inputText({
    message: t(lang, 'tg.field.channel'),
    default: current?.channelId ?? 'default',
  })
  const messengers = new Set(cfg.messengers || [])
  messengers.add('telegram')
  return {
    ...cfg,
    messengers: Array.from(messengers),
    telegram: { botToken: token, channelId: channelId || 'default' },
  }
}

async function configureFeishu(lang: Lang, cfg: Config): Promise<Config> {
  console.log()
  console.log(t(lang, 'feishu.docs'))
  console.log()
  const current = cfg.feishu
  const appId = await inputText({
    message: t(lang, 'feishu.field.app_id'),
    default: current?.appId,
    required: true,
  })
  const secretLabel = current?.appSecret
    ? t(lang, 'feishu.field.app_secret_keep')
    : t(lang, 'feishu.field.app_secret')
  const secretIn = await inputSecret({
    message: secretLabel,
    required: !current?.appSecret,
  })
  const appSecret = secretIn || current?.appSecret || ''
  const messengers = new Set(cfg.messengers || [])
  messengers.add('feishu')
  return {
    ...cfg,
    messengers: Array.from(messengers),
    feishu: { appId, appSecret, channelId: current?.channelId },
  }
}

async function configureDingtalk(lang: Lang, cfg: Config): Promise<Config> {
  console.log()
  console.log(t(lang, 'dingtalk.docs'))
  console.log()
  const current = cfg.dingtalk
  const clientId = await inputText({
    message: t(lang, 'dingtalk.field.client_id'),
    default: current?.clientId,
    required: true,
  })
  const secretLabel = current?.clientSecret
    ? t(lang, 'dingtalk.field.client_secret_keep')
    : t(lang, 'dingtalk.field.client_secret')
  const secretIn = await inputSecret({
    message: secretLabel,
    required: !current?.clientSecret,
  })
  const clientSecret = secretIn || current?.clientSecret || ''

  // Batch 1 (#4) — access policy + (#7) ack-reaction. Both default to the
  // pre-1.2.37 behavior ('open' / 'off') so an existing config keeps
  // working without re-running the wizard.
  const dmPolicy = (await menu<'open' | 'pairing' | 'allowlist' | 'keep'>({
    lang,
    message: t(lang, 'dingtalk.field.dm_policy'),
    choices: [
      { value: 'open', name: t(lang, 'dingtalk.policy.open') },
      { value: 'pairing', name: t(lang, 'dingtalk.policy.pairing') },
      { value: 'allowlist', name: t(lang, 'dingtalk.policy.allowlist') },
      { value: 'keep', name: t(lang, 'dingtalk.keep_default') },
    ],
  })) as 'open' | 'pairing' | 'allowlist' | 'keep' | typeof BACK
  if (dmPolicy === BACK) return cfg
  const groupPolicy = (await menu<'open' | 'allowlist' | 'disabled' | 'keep'>({
    lang,
    message: t(lang, 'dingtalk.field.group_policy'),
    choices: [
      { value: 'open', name: t(lang, 'dingtalk.policy.open') },
      { value: 'allowlist', name: t(lang, 'dingtalk.policy.allowlist') },
      { value: 'disabled', name: t(lang, 'dingtalk.policy.disabled') },
      { value: 'keep', name: t(lang, 'dingtalk.keep_default') },
    ],
  })) as 'open' | 'allowlist' | 'disabled' | 'keep' | typeof BACK
  if (groupPolicy === BACK) return cfg
  const ackReaction = (await menu<'off' | 'emoji' | 'kaomoji' | 'keep'>({
    lang,
    message: t(lang, 'dingtalk.field.ack_reaction'),
    choices: [
      { value: 'off', name: t(lang, 'dingtalk.ack.off') },
      { value: 'emoji', name: t(lang, 'dingtalk.ack.emoji') },
      { value: 'kaomoji', name: t(lang, 'dingtalk.ack.kaomoji') },
      { value: 'keep', name: t(lang, 'dingtalk.keep_default') },
    ],
  })) as 'off' | 'emoji' | 'kaomoji' | 'keep' | typeof BACK
  if (ackReaction === BACK) return cfg

  const messengers = new Set(cfg.messengers || [])
  messengers.add('dingtalk')
  return {
    ...cfg,
    messengers: Array.from(messengers),
    dingtalk: {
      clientId,
      clientSecret,
      channelId: current?.channelId,
      dmPolicy: dmPolicy === 'keep' ? (current?.dmPolicy || 'open') : dmPolicy,
      groupPolicy: groupPolicy === 'keep' ? (current?.groupPolicy || 'open') : groupPolicy,
      ackReaction: ackReaction === 'keep' ? (current?.ackReaction || 'off') : ackReaction,
      // allowFrom / groupAllowFrom not edited here — operators with allowlist
      // mode use config.json or the Web admin (#4 cont.) to manage the lists.
      allowFrom: current?.allowFrom,
      groupAllowFrom: current?.groupAllowFrom,
    },
  }
}

async function configureDiscord(lang: Lang, cfg: Config): Promise<Config> {
  console.log()
  console.log(t(lang, 'discord.docs'))
  console.log()
  const current = cfg.discord
  const tokenLabel = current?.botToken
    ? t(lang, 'discord.field.token_keep')
    : t(lang, 'discord.field.token')
  const tokenIn = await inputSecret({
    message: tokenLabel,
    required: !current?.botToken,
  })
  const token = tokenIn || current?.botToken || ''
  const channelId = await inputText({
    message: t(lang, 'discord.field.channel'),
    default: current?.channelId ?? 'default',
  })
  const guildsRaw = await inputText({
    message: t(lang, 'discord.field.guilds'),
    default: (current?.allowedGuilds ?? []).join(','),
  })
  const channelsRaw = await inputText({
    message: t(lang, 'discord.field.channels'),
    default: (current?.allowedChannels ?? []).join(','),
  })
  const messengers = new Set(cfg.messengers || [])
  messengers.add('discord')
  return {
    ...cfg,
    messengers: Array.from(messengers),
    discord: {
      botToken: token,
      channelId: channelId || 'default',
      allowedGuilds: guildsRaw ? guildsRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined,
      allowedChannels: channelsRaw ? channelsRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined,
    },
  }
}

// ─── agents section ────────────────────────────────────────────────────
//
// Each agent has a CLI binary; we probe with `<cmd> --version` to detect
// installation. Sub-menu lets the user enable/disable, see install
// instructions, set as default, or re-check after they installed
// something in another terminal.

type AgentId = 'agim' | 'native' | 'claude-code' | 'opencode' | 'codex' | 'copilot' | 'antigravity' | 'cursor' | 'kimi-code' | 'qoder' | 'pi' | 'mimo'

interface AgentSpec {
  id: AgentId
  /** CLI binary to probe. */
  cmd: string
  /** Some CLIs do not expose --version; override with a cheap success path. */
  probeArgs?: string[]
  /** Whether this agent needs a separate `<cmd> auth login` step we
   *  should hint at. (claude-code uses claude.ai login flow inside the
   *  CLI itself.) */
  authHintKey?: Key
}

const AGENT_SPECS: AgentSpec[] = [
  { id: 'native',      cmd: '__native__' },
  { id: 'claude-code', cmd: 'claude' },
  { id: 'opencode',    cmd: 'opencode',     authHintKey: 'agents.auth_hint.opencode' },
  { id: 'codex',       cmd: 'codex',        authHintKey: 'agents.auth_hint.codex' },
  { id: 'copilot',     cmd: 'copilot',      authHintKey: 'agents.auth_hint.copilot' },
  { id: 'antigravity', cmd: 'agy',          probeArgs: ['help'], authHintKey: 'agents.auth_hint.antigravity' },
  { id: 'cursor',      cmd: 'cursor-agent', authHintKey: 'agents.auth_hint.cursor' },
  { id: 'kimi-code',   cmd: 'kimi',         authHintKey: 'agents.auth_hint.kimi-code' },
  { id: 'qoder',       cmd: 'qodercli',     authHintKey: 'agents.auth_hint.qoder' },
  { id: 'pi',          cmd: 'pi',           authHintKey: 'agents.auth_hint.pi' },
  { id: 'mimo',        cmd: 'mimo',         authHintKey: 'agents.auth_hint.mimo' },
]

async function nativeLlmConfigured(): Promise<boolean> {
  try {
    const cfg = await loadConfig()
    const raw = cfg as {
      llmBackends?: Array<{ name?: unknown; provider?: unknown; baseUrl?: unknown }>
    }
    if (!Array.isArray(raw.llmBackends) || raw.llmBackends.length === 0) return false
    return raw.llmBackends.some((backend) => {
      if (!backend || typeof backend.name !== 'string' || backend.name.trim() === '') return false
      const provider = typeof backend.provider === 'string' ? backend.provider : undefined
      const baseUrl = typeof backend.baseUrl === 'string' ? backend.baseUrl : undefined
      return describeSecretSource(backend.name, { provider, baseUrl }).source !== 'none'
    })
  } catch {
    return false
  }
}

/** Detect install state once per sectionAgents() call, but always
 *  re-detect after the user picks "Re-check". */
async function detectAgentInstalls(): Promise<Map<AgentId, boolean>> {
  const out = new Map<AgentId, boolean>()
  await Promise.all(AGENT_SPECS.map(async spec => {
    if (spec.id === 'agim' || spec.id === 'native') {
      out.set(spec.id, await nativeLlmConfigured())
      return
    }
    out.set(spec.id, await cliAvailable(spec.cmd, spec.probeArgs))
  }))
  return out
}

function agentStatus(lang: Lang, enabled: boolean, installed: boolean): string {
  if (enabled && installed)  return t(lang, 'agents.status.enabled_installed')
  if (enabled && !installed) return t(lang, 'agents.status.enabled_missing')
  if (!enabled && installed) return t(lang, 'agents.status.disabled_installed')
  return t(lang, 'agents.status.disabled_missing')
}

async function sectionAgents(lang: Lang, cfg: Config): Promise<Config> {
  let config = cfg
  let installs = await detectAgentInstalls()
  while (true) {
    // Effective enabled list: union of cfg.agents + cfg.defaultAgent.
    // Historical configs can drift into `agents: []` + a non-empty
    // `defaultAgent` from the legacy `config <agent>` flow.
    const validIds = new Set(AGENT_SPECS.map(s => s.id))
    const effective = new Set([
      ...((config.agents || []).filter(a => validIds.has(a as AgentId))),
      ...(config.defaultAgent && validIds.has(config.defaultAgent as AgentId) ? [config.defaultAgent] : []),
    ])

    console.log()
    console.log(t(lang, 'agents.title'))
    console.log(t(lang, 'agents.subtitle'))
    console.log()

    const choices: Array<{ value: string; name: string; separatorBefore?: boolean }> = []
    for (const spec of AGENT_SPECS) {
      const enabled = effective.has(spec.id)
      const installed = installs.get(spec.id) ?? false
      choices.push({
        value: spec.id,
        name: t(lang, 'agents.row', {
          label: t(lang, (`agents.label.${spec.id}`) as Key),
          status: agentStatus(lang, enabled, installed),
        }),
      })
    }
    if (effective.size > 0) {
      choices.push({
        value: '__set_default__',
        name: t(lang, 'agents.set_default_action'),
        separatorBefore: true,
      })
    }
    choices.push({
      value: '__recheck__',
      name: t(lang, 'agents.action.recheck'),
      separatorBefore: effective.size === 0,
    })

    const picked = await menu<string>({
      lang,
      message: t(lang, 'menu.subtitle'),
      choices,
      back: 'agents.action.back',
    })
    if (picked === BACK) return config

    if (picked === '__recheck__') {
      installs = await detectAgentInstalls()
      console.log('🔄 Re-checked all agents.')
      continue
    }
    if (picked === '__set_default__') {
      const enabledIds = Array.from(effective)
      const def = await menu<string>({
        lang,
        message: t(lang, 'agents.default_picker'),
        choices: enabledIds.map(id => ({
          value: id,
          name: t(lang, (`agents.label.${id}`) as Key),
        })),
        default: enabledIds.includes(config.defaultAgent) ? config.defaultAgent : enabledIds[0],
        back: 'agents.action.back',
      })
      if (def === BACK) continue
      // Also ensure the picked default is in agents[] (it must be for
      // routing to work).
      const agents = new Set(config.agents || [])
      agents.add(def as string)
      config = { ...config, agents: Array.from(agents), defaultAgent: def as string }
      console.log(t(lang, 'agents.default_set', { label: t(lang, (`agents.label.${def}`) as Key) }))
      continue
    }

    const spec = AGENT_SPECS.find(s => s.id === picked)
    if (!spec) continue
    try {
      config = await agentSubMenu(lang, config, spec, installs, effective.has(spec.id))
    } catch (err) {
      if (err instanceof UserAbortError) continue
      throw err
    }
  }
}

async function agentSubMenu(
  lang: Lang,
  cfg: Config,
  spec: AgentSpec,
  installs: Map<AgentId, boolean>,
  enabled: boolean,
): Promise<Config> {
  let config = cfg
  let isEnabled = enabled
  while (true) {
    const installed = installs.get(spec.id) ?? false
    const label = t(lang, (`agents.label.${spec.id}`) as Key)
    console.log()
    console.log(`${label} — ${agentStatus(lang, isEnabled, installed)}`)
    console.log(installed
      ? t(lang, 'agents.installed_msg', { label })
      : t(lang, 'agents.missing_msg',   { label }))
    if (spec.authHintKey) console.log(t(lang, spec.authHintKey))
    console.log()

    const choices: Array<{ value: string; name: string }> = []
    if (!isEnabled) {
      choices.push({ value: 'enable', name: t(lang, 'agents.action.enable') })
    } else {
      choices.push({ value: 'set_default', name: t(lang, 'agents.action.set_default') })
      choices.push({ value: 'disable', name: t(lang, 'agents.action.disable') })
    }
    choices.push({ value: 'install_hint', name: t(lang, 'agents.action.install_hint') })
    choices.push({ value: 'recheck', name: t(lang, 'agents.action.recheck') })

    const action = await menu<string>({
      lang,
      message: t(lang, 'menu.subtitle'),
      choices,
      back: 'agents.action.back',
    })
    if (action === BACK) return config

    if (action === 'enable') {
      const agents = new Set(config.agents || [])
      agents.add(spec.id)
      // If there's no default yet, this agent becomes the default.
      const alsoDefault = !config.defaultAgent
      const next: Config = {
        ...config,
        agents: Array.from(agents),
        defaultAgent: alsoDefault ? spec.id : config.defaultAgent,
      }
      config = next
      isEnabled = true
      console.log(t(lang, 'agents.enabled', {
        label,
        also_default: alsoDefault ? t(lang, 'agents.also_default') : '',
      }))
    } else if (action === 'disable') {
      const agents = (config.agents || []).filter(a => a !== spec.id)
      let defaultAgent = config.defaultAgent
      if (defaultAgent === spec.id) {
        // Promote the next enabled agent (or empty).
        defaultAgent = agents[0] ?? ''
      }
      config = { ...config, agents, defaultAgent }
      isEnabled = false
      console.log(t(lang, 'agents.removed', { label }))
    } else if (action === 'set_default') {
      const agents = new Set(config.agents || [])
      agents.add(spec.id)
      config = { ...config, agents: Array.from(agents), defaultAgent: spec.id }
      console.log(t(lang, 'agents.default_set', { label }))
    } else if (action === 'install_hint') {
      console.log()
      console.log(t(lang, (`agents.install_hint.${spec.id}`) as Key))
      if (spec.authHintKey) console.log(t(lang, spec.authHintKey))
      console.log()
    } else if (action === 'recheck') {
      const newInstalls = await detectAgentInstalls()
      installs.set(spec.id, newInstalls.get(spec.id) ?? false)
      console.log('🔄 Re-checked.')
    }
  }
}

// ─── Agim Agent (model API) section ────────────────────────────────────

async function sectionAgimAgent(lang: Lang): Promise<void> {
  while (true) {
    const cfg = await loadConfig()
    const raw = cfg as { llmBackends?: unknown[] }
    const backendCount = Array.isArray(raw.llmBackends) ? raw.llmBackends.length : 0
    const ready = await nativeLlmConfigured()

    console.log()
    console.log(t(lang, 'agim_agent.title'))
    console.log(t(lang, 'agim_agent.subtitle', {
      backends: String(backendCount),
      status: ready ? t(lang, 'agim_agent.status.ready') : t(lang, 'agim_agent.status.missing'),
    }))
    console.log()

    const action = (await menu<'add' | 'secret' | 'role' | 'remove' | 'native_enable' | 'list' | 'diag'>({
      lang,
      message: t(lang, 'menu.subtitle'),
      choices: [
        { value: 'add', name: t(lang, 'agim_agent.action.add') },
        {
          value: 'secret',
          name: t(lang, 'agim_agent.action.secret'),
          disabled: backendCount === 0 ? t(lang, 'agim_agent.disabled.need_backend') : false,
        },
        {
          value: 'role',
          name: t(lang, 'agim_agent.action.role'),
          disabled: backendCount === 0 ? t(lang, 'agim_agent.disabled.need_backend') : false,
        },
        {
          value: 'remove',
          name: t(lang, 'agim_agent.action.remove'),
          disabled: backendCount === 0 ? t(lang, 'agim_agent.disabled.need_backend') : false,
        },
        {
          value: 'native_enable',
          name: t(lang, 'agim_agent.action.native_enable'),
          disabled: backendCount === 0 ? t(lang, 'agim_agent.disabled.need_backend') : false,
        },
        { value: 'list', name: t(lang, 'agim_agent.action.list') },
        { value: 'diag', name: t(lang, 'agim_agent.action.diag') },
      ],
      back: 'agim_agent.action.back',
    })) as 'add' | 'secret' | 'role' | 'remove' | 'native_enable' | 'list' | 'diag' | typeof BACK
    if (action === BACK) return

    if (action === 'diag') {
      const { runDiagLlm } = await import('./diag.js')
      const code = await runDiagLlm()
      if (code !== 0) console.log(t(lang, 'agim_agent.command_failed', { code: String(code) }))
      continue
    }

    const { runSetupLlm } = await import('./setup-llm.js')
    const args = (
      action === 'add' ? ['add']
        : action === 'secret' ? ['secret']
          : action === 'role' ? ['role']
            : action === 'remove' ? ['remove']
              : action === 'native_enable' ? ['native-enable']
                : ['list']
    )
    const code = await runSetupLlm(args)
    if (code !== 0) console.log(t(lang, 'agim_agent.command_failed', { code: String(code) }))
  }
}

// ─── IM admin picker section ────────────────────────────────────────────

function adminKey(platform: string, userId: string): string {
  return `${platform}\u0000${userId}`
}

function decodeAdminKey(key: string): { platform: string; userId: string } {
  const idx = key.indexOf('\u0000')
  if (idx < 0) return { platform: key, userId: '' }
  return { platform: key.slice(0, idx), userId: key.slice(idx + 1) }
}

async function sectionAdmins(lang: Lang): Promise<void> {
  while (true) {
    const admins = listAdmins()
    const known = listKnownImUsers()
    const adminSet = new Set(admins.map((a) => adminKey(a.platform, a.userId)))
    const candidates = known.filter((u) => !adminSet.has(adminKey(u.platform, u.userId)))

    console.log()
    console.log(t(lang, 'admins.title'))
    console.log(t(lang, 'admins.subtitle', {
      admins: String(admins.length),
      known: String(known.length),
    }))
    console.log()

    const action = (await menu<'add' | 'remove' | 'show'>({
      lang,
      message: t(lang, 'menu.subtitle'),
      choices: [
        {
          value: 'add',
          name: t(lang, 'admins.action.add'),
          disabled: candidates.length === 0 ? t(lang, 'admins.disabled.no_candidate') : false,
        },
        {
          value: 'remove',
          name: t(lang, 'admins.action.remove'),
          disabled: admins.length === 0 ? t(lang, 'admins.disabled.no_admin') : false,
        },
        { value: 'show', name: t(lang, 'admins.action.show') },
      ],
      back: 'admins.action.back',
    })) as 'add' | 'remove' | 'show' | typeof BACK
    if (action === BACK) return

    if (action === 'show') {
      if (admins.length === 0) console.log(t(lang, 'admins.current.empty'))
      else {
        console.log(t(lang, 'admins.current.title', { count: String(admins.length) }))
        for (const row of admins) console.log(`  ${row.platform}:${row.userId}`)
      }
      if (known.length === 0) console.log(t(lang, 'admins.known.empty'))
      else {
        console.log(t(lang, 'admins.known.title', { count: String(known.length) }))
        for (const row of known) {
          console.log(`  ${row.platform}:${row.userId}  last_seen=${row.lastSeenAt}`)
        }
      }
      continue
    }

    if (action === 'add') {
      const picked = (await menu<string>({
        lang,
        message: t(lang, 'admins.pick.add'),
        choices: candidates.map((row) => ({
          value: adminKey(row.platform, row.userId),
          name: `${row.platform}:${row.userId}  last_seen=${row.lastSeenAt}`,
        })),
        back: 'admins.action.back',
      })) as string | typeof BACK
      if (picked === BACK) continue
      const target = decodeAdminKey(picked)
      const changed = await promoteAdmin(target.platform, target.userId, { actor: 'cli:config' })
      console.log(changed
        ? t(lang, 'admins.result.added', { target: `${target.platform}:${target.userId}` })
        : t(lang, 'admins.result.already', { target: `${target.platform}:${target.userId}` }))
      continue
    }

    const picked = (await menu<string>({
      lang,
      message: t(lang, 'admins.pick.remove'),
      choices: admins.map((row) => ({
        value: adminKey(row.platform, row.userId),
        name: `${row.platform}:${row.userId}`,
      })),
      back: 'admins.action.back',
    })) as string | typeof BACK
    if (picked === BACK) continue
    const target = decodeAdminKey(picked)
    const changed = await revokeAdmin(target.platform, target.userId, { actor: 'cli:config' })
    console.log(changed
      ? t(lang, 'admins.result.removed', { target: `${target.platform}:${target.userId}` })
      : t(lang, 'admins.result.missing', { target: `${target.platform}:${target.userId}` }))
  }
}

// ─── SMTP section ──────────────────────────────────────────────────────

interface SmtpPreset {
  id: 'gmail' | 'outlook' | 'qq' | '163' | 'custom' | 'skip'
  host?: string
  port?: number
  secure?: 'auto' | 'true' | 'false'
}

const SMTP_PRESETS: SmtpPreset[] = [
  { id: 'gmail',   host: 'smtp.gmail.com',        port: 465, secure: 'true'  },
  { id: 'outlook', host: 'smtp.office365.com',    port: 587, secure: 'false' },
  { id: 'qq',      host: 'smtp.qq.com',           port: 465, secure: 'true'  },
  { id: '163',     host: 'smtp.163.com',          port: 465, secure: 'true'  },
  { id: 'custom' },
  { id: 'skip' },
]

async function sectionSmtp(lang: Lang): Promise<void> {
  console.log()
  console.log(t(lang, 'smtp.title'))
  console.log(t(lang, 'smtp.subtitle', { envFile: ENV_FILE }))

  // Use the effective env (env file + process.env fallback) so SMTP keys
  // set via the systemd unit's Environment= lines also show up in the
  // prefill — historical installs put them there directly.
  const current = readEffectiveEnv()
  const hasExisting = Boolean(current.AGIM_SMTP_HOST && current.AGIM_SMTP_USER)
  console.log(hasExisting
    ? t(lang, 'smtp.current_set', {
        user: current.AGIM_SMTP_USER ?? '',
        host: current.AGIM_SMTP_HOST ?? '',
        port: current.AGIM_SMTP_PORT ?? '?',
      })
    : t(lang, 'smtp.current_unset'))
  console.log()

  const action = (await menu<'edit' | 'disable'>({
    lang,
    message: t(lang, 'menu.subtitle'),
    choices: [
      { value: 'edit', name: t(lang, 'smtp.action.edit') },
      { value: 'disable', name: t(lang, 'smtp.action.disable'), disabled: !hasExisting },
    ],
    back: 'smtp.action.back',
  })) as 'edit' | 'disable' | typeof BACK
  if (action === BACK) return
  if (action === 'disable') {
    for (const k of ['AGIM_SMTP_HOST', 'AGIM_SMTP_PORT', 'AGIM_SMTP_USER', 'AGIM_SMTP_PASS', 'AGIM_SMTP_FROM', 'AGIM_SMTP_SECURE']) {
      unsetEnvKey(k)
    }
    console.log(t(lang, 'smtp.cleared', { file: ENV_FILE }))
    return
  }

  const presetId = (await menu<SmtpPreset['id'] | typeof BACK>({
    lang,
    message: t(lang, 'smtp.preset'),
    choices: SMTP_PRESETS.filter(p => p.id !== 'skip').map(p => ({
      value: p.id,
      name: t(lang, `smtp.preset.${p.id}` as never),
    })),
    back: 'smtp.action.back',
  })) as SmtpPreset['id'] | typeof BACK
  if (presetId === BACK) return
  const preset = SMTP_PRESETS.find(p => p.id === presetId)
  if (!preset) return

  // Prefill priority: existing user value first, then preset default.
  // Picking a known preset (gmail/qq/etc) while already-configured shouldn't
  // erase the user's working host — they probably picked it just to grab the
  // suggested port/TLS pair.
  const host = await inputText({
    message: t(lang, 'smtp.field.host'),
    default: current.AGIM_SMTP_HOST ?? preset.host,
    required: true,
  })
  const port = await inputText({
    message: t(lang, 'smtp.field.port'),
    default: String(current.AGIM_SMTP_PORT ?? preset.port ?? 465),
    required: true,
    validate: v => /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536 || '1..65535',
  })
  const user = await inputText({
    message: t(lang, 'smtp.field.user'),
    default: current.AGIM_SMTP_USER,
    required: true,
  })
  // Password: never prefill literally (leaks via scrollback). Empty input
  // means "keep what's stored". When nothing is stored yet, require it.
  const passInput = await inputSecret({
    message: t(lang, current.AGIM_SMTP_PASS ? 'smtp.field.pass_keep' : 'smtp.field.pass'),
    required: !current.AGIM_SMTP_PASS,
  })
  const pass = passInput || current.AGIM_SMTP_PASS || ''
  const from = await inputText({
    message: t(lang, 'smtp.field.from'),
    default: current.AGIM_SMTP_FROM || user,
  })
  let secure: 'auto' | 'true' | 'false' = preset.secure ?? (current.AGIM_SMTP_SECURE as 'auto'|'true'|'false') ?? 'auto'
  if (presetId === 'custom') {
    secure = (await menu<'auto' | 'true' | 'false'>({
      lang,
      message: t(lang, 'smtp.field.secure'),
      choices: [
        { value: 'auto', name: t(lang, 'smtp.secure.auto') },
        { value: 'true', name: t(lang, 'smtp.secure.true') },
        { value: 'false', name: t(lang, 'smtp.secure.false') },
      ],
      default: secure,
    })) as 'auto' | 'true' | 'false'
  }
  updateEnvFile({
    AGIM_SMTP_HOST: host,
    AGIM_SMTP_PORT: port,
    AGIM_SMTP_USER: user,
    AGIM_SMTP_PASS: pass,
    AGIM_SMTP_FROM: from,
    AGIM_SMTP_SECURE: secure,
  })
  console.log(t(lang, 'smtp.saved', { file: ENV_FILE }))
  // Warn if any wizard-managed SMTP key is also set by the running env
  // (most commonly: systemd unit's `Environment=` lines). Writing the
  // env file alone won't change the active value in that case.
  for (const k of ['AGIM_SMTP_HOST', 'AGIM_SMTP_PORT', 'AGIM_SMTP_USER', 'AGIM_SMTP_PASS', 'AGIM_SMTP_FROM']) {
    if (hasProcessEnvOverride(k)) {
      console.log(t(lang, 'env.shadowed_warn', { key: k, file: ENV_FILE }))
      break // one warning is enough; user gets the picture
    }
  }
}

// ─── Baidu Maps section ────────────────────────────────────────────────

async function sectionBaidu(lang: Lang): Promise<void> {
  while (true) {
    console.log()
    console.log(t(lang, 'baidu.title'))
    console.log(t(lang, 'baidu.subtitle'))
    console.log(t(lang, 'baidu.howto'))
    console.log()
    // Effective env so a key set via the systemd unit / shell export
    // still shows up here, not just keys written into ~/.agim/env.
    const current = readEffectiveEnv().AGIM_BAIDU_MAP_AK
    const status = current ? `${current.slice(0, 6)}…${current.slice(-4)} (set)` : '(unset)'
    const action = (await menu<'set' | 'clear'>({
      lang,
      message: `current: ${status}`,
      choices: [
        { value: 'set', name: t(lang, 'baidu.action.set') },
        { value: 'clear', name: t(lang, 'baidu.action.clear'), disabled: !current },
      ],
      back: 'baidu.action.back',
    })) as 'set' | 'clear' | typeof BACK
    if (action === BACK) return
    if (action === 'clear') {
      unsetEnvKey('AGIM_BAIDU_MAP_AK')
      console.log(t(lang, 'baidu.cleared'))
      continue
    }
    const ak = await inputText({
      message: t(lang, 'baidu.input'),
      default: current,
      validate: v => {
        if (!v) return 'Required (or pick ← Back)'
        if (v.length < 24 || v.length > 64) return 'AK length looks wrong (expected ~32 chars)'
        return true
      },
    })
    updateEnvFile({ AGIM_BAIDU_MAP_AK: ak })
    console.log(t(lang, 'baidu.saved', { file: ENV_FILE }))
    if (hasProcessEnvOverride('AGIM_BAIDU_MAP_AK')) {
      console.log(t(lang, 'env.shadowed_warn', { key: 'AGIM_BAIDU_MAP_AK', file: ENV_FILE }))
    }
  }
}

// ─── Web port section ─────────────────────────────────────────────────
//
// On first-run we keep this intentionally small: only expose webPort.
async function sectionWeb(lang: Lang, cfg: Config): Promise<Config> {
  let config = cfg
  while (true) {
    console.log()
    console.log(t(lang, 'web.title'))
    console.log(t(lang, 'web.subtitle'))
    console.log()

    const currentPort = (config.webPort as number | undefined) ?? 3000

    const action = (await menu<'port'>({
      lang,
      message: t(lang, 'web.current', { port: String(currentPort) }),
      choices: [
        { value: 'port', name: t(lang, 'web.action.port') },
      ],
      back: 'web.action.back',
    })) as 'port' | typeof BACK
    if (action === BACK) return config

    const portStr = await inputText({
      message: t(lang, 'web.port.prompt', { current: String(currentPort) }),
      default: String(currentPort),
      validate: (v) => {
        if (!v.trim()) return 'Required (or pick ← Back)'
        const n = parseInt(v, 10)
        if (!Number.isFinite(n)) return 'Must be a number'
        if (n < 1 || n > 65535) return 'Must be in 1..65535'
        if (n < 1024) return 'Ports < 1024 require root; pick something >= 1024'
        return true
      },
    })
    const port = parseInt(portStr, 10)
    config = { ...config, webPort: port }
    console.log(t(lang, 'web.port.saved', { port: String(port) }))
  }
}
