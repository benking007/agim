// cli-ui/config-wizard.ts — interactive `im-hub-pro config` flow.
//
// Top-level menu has 5 sections:
//   1. Messengers     — checkbox of [wechat, telegram, feishu, discord, email]
//   2. Agents         — checkbox of [claude-code, opencode, codex, copilot] + default-agent pick
//   3. Remote ACP     — list / add / edit / remove
//   4. SMTP           — preset picker → host/port/user/pass/from/secure (writes to ENV_FILE)
//   5. Baidu Maps AK  — set / clear (writes IMHUB_BAIDU_MAP_AK to ENV_FILE)
//
// Each section loops until the user picks "← Back". Edits land in the
// in-memory Config object until "Done — save and exit". Config is then
// persisted via core/onboarding.saveConfig (which writes config.json with
// chmod 600). SMTP / Baidu writes go through env-file.ts immediately so a
// crash mid-wizard doesn't lose the secrets the user already typed.

import {
  menu,
  multiSelect,
  inputText,
  inputSecret,
  yesNo,
  BACK,
  UserAbortError,
} from './prompts.js'
import { t, type Lang } from './i18n.js'
import { loadConfig, saveConfig, type Config } from '../core/onboarding.js'
import { CONFIG_DIR } from './paths.js'
import { ENV_FILE, readEnvFile, updateEnvFile, unsetEnvKey } from './env-file.js'

type Section = 'messengers' | 'agents' | 'acp' | 'smtp' | 'baidu' | 'done'

export async function runConfigWizard(lang: Lang): Promise<void> {
  let config = await loadConfig()
  console.log()
  console.log(t(lang, 'config.title'))
  console.log(t(lang, 'config.subtitle'))
  console.log()

  while (true) {
    let picked: Section | typeof BACK
    try {
      picked = (await menu<Section>({
        lang,
        message: t(lang, 'menu.subtitle'),
        choices: [
          { value: 'messengers', name: t(lang, 'config.section.messengers') },
          { value: 'agents', name: t(lang, 'config.section.agents') },
          { value: 'acp', name: t(lang, 'config.section.acp') },
          { value: 'smtp', name: t(lang, 'config.section.smtp') },
          { value: 'baidu', name: t(lang, 'config.section.baidu') },
          { value: 'done', name: t(lang, 'config.section.done'), separatorBefore: true },
        ],
      })) as Section | typeof BACK
    } catch (err) {
      if (err instanceof UserAbortError) return
      throw err
    }
    if (picked === BACK || picked === 'done') break

    try {
      if (picked === 'messengers') config = await sectionMessengers(lang, config)
      else if (picked === 'agents') config = await sectionAgents(lang, config)
      else if (picked === 'acp') config = await sectionAcp(lang, config)
      else if (picked === 'smtp') await sectionSmtp(lang)
      else if (picked === 'baidu') await sectionBaidu(lang)
    } catch (err) {
      if (err instanceof UserAbortError) continue // Ctrl-C inside a section → bounce back to the top menu
      throw err
    }
  }

  await saveConfig(config)
  console.log()
  console.log(t(lang, 'config.saved', { file: `${CONFIG_DIR}/config.json` }))
}

// ─── messengers section ────────────────────────────────────────────────

async function sectionMessengers(lang: Lang, cfg: Config): Promise<Config> {
  // Map between display id and the canonical messenger id we persist.
  // wechat → wechat-ilink; the rest map 1:1.
  const items: Array<{ id: string; persistAs: string; key: 'wechat' | 'telegram' | 'feishu' | 'discord' | 'email' }> = [
    { id: 'wechat-ilink', persistAs: 'wechat-ilink', key: 'wechat' },
    { id: 'telegram', persistAs: 'telegram', key: 'telegram' },
    { id: 'feishu', persistAs: 'feishu', key: 'feishu' },
    { id: 'discord', persistAs: 'discord', key: 'discord' },
    { id: 'email', persistAs: 'email', key: 'email' },
  ]
  // Pre-menu so user can pick "← Back" without committing to the
  // checkbox edit. inquirer's checkbox prompt has no built-in back, and
  // Ctrl-C is invisible to first-time users.
  const current = cfg.messengers || []
  console.log()
  console.log(t(lang, 'messengers.title'))
  console.log(current.length === 0
    ? t(lang, 'messengers.current_none')
    : t(lang, 'messengers.current', { list: current.join(', ') }))
  console.log()
  const action = await menu<'edit'>({
    lang,
    message: t(lang, 'menu.subtitle'),
    choices: [
      { value: 'edit', name: t(lang, 'messengers.action.edit') },
    ],
    back: 'messengers.action.back',
  })
  if (action === BACK) return cfg
  const picked = await multiSelect<string>({
    lang,
    message: t(lang, 'messengers.pick'),
    choices: items.map(it => ({
      value: it.persistAs,
      name: t(lang, `messengers.hint.${it.key}` as never),
      checked: new Set(current).has(it.persistAs),
    })),
  })
  console.log(t(lang, 'messengers.saved'))
  return { ...cfg, messengers: picked }
}

// ─── agents section ────────────────────────────────────────────────────

async function sectionAgents(lang: Lang, cfg: Config): Promise<Config> {
  const items: Array<{ id: string; key: 'claude' | 'opencode' | 'codex' | 'copilot' }> = [
    { id: 'claude-code', key: 'claude' },
    { id: 'opencode', key: 'opencode' },
    { id: 'codex', key: 'codex' },
    { id: 'copilot', key: 'copilot' },
  ]
  // Effective enabled list: union of cfg.agents and cfg.defaultAgent.
  // Reason: historical configs can drift into `agents: []` + a non-empty
  // `defaultAgent` (legacy `config <agent>` flow + a later wizard run that
  // unchecked all). Reading `cfg.agents` alone made the wizard show the
  // user's working default-agent as unchecked, which looked like the
  // wizard "lost their selection" (user-reported 2026-05-11).
  const validIds = new Set(items.map(i => i.id))
  const effective = Array.from(new Set([
    ...(cfg.agents || []),
    ...(cfg.defaultAgent && validIds.has(cfg.defaultAgent) ? [cfg.defaultAgent] : []),
  ]))
  console.log()
  console.log(t(lang, 'agents.title'))
  console.log(effective.length === 0
    ? t(lang, 'agents.current_none')
    : t(lang, 'agents.current', { list: effective.join(', '), default: cfg.defaultAgent ?? '(none)' }))
  console.log()
  const choices: Array<{ value: 'edit' | 'default'; name: string }> = [
    { value: 'edit', name: t(lang, 'agents.action.edit') },
  ]
  if (effective.length > 1) {
    choices.push({ value: 'default', name: t(lang, 'agents.action.default') })
  }
  const action = await menu<'edit' | 'default'>({
    lang,
    message: t(lang, 'menu.subtitle'),
    choices,
    back: 'agents.action.back',
  })
  if (action === BACK) return cfg

  if (action === 'default') {
    // Just pick default agent from already-enabled list.
    const def = await menu<string>({
      lang,
      message: t(lang, 'agents.default'),
      choices: effective.map(p => ({ value: p, name: p })),
      default: effective.includes(cfg.defaultAgent) ? cfg.defaultAgent : effective[0],
    }) as string
    return { ...cfg, agents: effective, defaultAgent: def }
  }

  const current = new Set(effective)
  const picked = await multiSelect<string>({
    lang,
    message: t(lang, 'agents.pick'),
    choices: items.map(it => ({
      value: it.id,
      name: t(lang, `agents.hint.${it.key}` as never),
      checked: current.has(it.id),
    })),
  })
  if (picked.length === 0) {
    // User explicitly unchecked everything — clear both fields so the
    // config doesn't carry a stale defaultAgent into the next run.
    console.log(t(lang, 'agents.saved'))
    return { ...cfg, agents: [], defaultAgent: '' }
  }
  // Default agent — pick from those just enabled.
  const def = await menu<string>({
    lang,
    message: t(lang, 'agents.default'),
    choices: picked.map(p => ({ value: p, name: p })),
    default: picked.includes(cfg.defaultAgent) ? cfg.defaultAgent : picked[0],
  }) as string
  console.log(t(lang, 'agents.saved'))
  return { ...cfg, agents: picked, defaultAgent: def }
}

// ─── ACP section ───────────────────────────────────────────────────────

async function sectionAcp(lang: Lang, cfg: Config): Promise<Config> {
  let agents = [...(cfg.acpAgents ?? [])]
  while (true) {
    const choices: Array<{ value: string; name: string }> = []
    choices.push({ value: '__add__', name: t(lang, 'acp.action.add') })
    for (const a of agents) {
      choices.push({ value: `edit:${a.name}`, name: t(lang, 'acp.action.edit', { name: a.name }) })
      choices.push({ value: `remove:${a.name}`, name: t(lang, 'acp.action.remove', { name: a.name }) })
    }
    const picked = (await menu<string>({
      lang,
      message: t(lang, 'acp.subtitle'),
      choices,
      back: 'acp.action.back',
    })) as string | typeof BACK
    if (picked === BACK) break

    if (picked === '__add__') {
      const a = await promptAcpAgent(lang)
      if (a) agents.push(a)
    } else if (picked.startsWith('remove:')) {
      const name = picked.slice('remove:'.length)
      agents = agents.filter(x => x.name !== name)
      console.log(t(lang, 'acp.removed', { name }))
    } else if (picked.startsWith('edit:')) {
      const name = picked.slice('edit:'.length)
      const idx = agents.findIndex(x => x.name === name)
      if (idx >= 0) {
        const updated = await promptAcpAgent(lang, agents[idx])
        if (updated) agents[idx] = updated
      }
    }
  }
  return { ...cfg, acpAgents: agents }
}

async function promptAcpAgent(
  lang: Lang,
  existing?: NonNullable<Config['acpAgents']>[number],
): Promise<NonNullable<Config['acpAgents']>[number] | null> {
  const name = await inputText({
    message: t(lang, 'acp.field.name'),
    default: existing?.name,
    required: true,
  })
  const endpoint = await inputText({
    message: t(lang, 'acp.field.endpoint'),
    default: existing?.endpoint,
    required: true,
    validate: v => /^https?:\/\//.test(v) || 'must start with http:// or https://',
  })
  const authType = (await menu<'none' | 'bearer'>({
    lang,
    message: t(lang, 'acp.field.auth_type'),
    choices: [
      { value: 'none', name: t(lang, 'acp.auth.none') },
      { value: 'bearer', name: t(lang, 'acp.auth.bearer') },
    ],
    default: (existing?.auth?.type === 'bearer' ? 'bearer' : 'none') as 'none' | 'bearer',
  })) as 'none' | 'bearer'
  let token: string | undefined
  if (authType === 'bearer') {
    token = await inputSecret({
      message: t(lang, 'acp.field.auth_token'),
      required: true,
    })
  }
  console.log(t(lang, 'acp.added', { name }))
  return {
    name,
    endpoint,
    auth: authType === 'none' ? { type: 'none' } : { type: 'bearer', token },
    enabled: true,
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
  console.log(t(lang, 'smtp.subtitle'))

  const current = readEnvFile()
  const hasExisting = Boolean(current.IMHUB_SMTP_HOST && current.IMHUB_SMTP_USER)
  console.log(hasExisting
    ? t(lang, 'smtp.current_set', {
        user: current.IMHUB_SMTP_USER ?? '',
        host: current.IMHUB_SMTP_HOST ?? '',
        port: current.IMHUB_SMTP_PORT ?? '?',
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
    for (const k of ['IMHUB_SMTP_HOST', 'IMHUB_SMTP_PORT', 'IMHUB_SMTP_USER', 'IMHUB_SMTP_PASS', 'IMHUB_SMTP_FROM', 'IMHUB_SMTP_SECURE']) {
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
  const preset = SMTP_PRESETS.find(p => p.id === presetId)!

  // Prefill priority: existing user value first, then preset default.
  // Picking a known preset (gmail/qq/etc) while already-configured shouldn't
  // erase the user's working host — they probably picked it just to grab the
  // suggested port/TLS pair.
  const host = await inputText({
    message: t(lang, 'smtp.field.host'),
    default: current.IMHUB_SMTP_HOST ?? preset.host,
    required: true,
  })
  const port = await inputText({
    message: t(lang, 'smtp.field.port'),
    default: String(current.IMHUB_SMTP_PORT ?? preset.port ?? 465),
    required: true,
    validate: v => /^\d+$/.test(v) && Number(v) > 0 && Number(v) < 65536 || '1..65535',
  })
  const user = await inputText({
    message: t(lang, 'smtp.field.user'),
    default: current.IMHUB_SMTP_USER,
    required: true,
  })
  // Password: never prefill literally (leaks via scrollback). Empty input
  // means "keep what's stored". When nothing is stored yet, require it.
  const passInput = await inputSecret({
    message: t(lang, current.IMHUB_SMTP_PASS ? 'smtp.field.pass_keep' : 'smtp.field.pass'),
    required: !current.IMHUB_SMTP_PASS,
  })
  const pass = passInput || current.IMHUB_SMTP_PASS || ''
  const from = await inputText({
    message: t(lang, 'smtp.field.from'),
    default: current.IMHUB_SMTP_FROM || user,
  })
  let secure: 'auto' | 'true' | 'false' = preset.secure ?? (current.IMHUB_SMTP_SECURE as 'auto'|'true'|'false') ?? 'auto'
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
    IMHUB_SMTP_HOST: host,
    IMHUB_SMTP_PORT: port,
    IMHUB_SMTP_USER: user,
    IMHUB_SMTP_PASS: pass,
    IMHUB_SMTP_FROM: from,
    IMHUB_SMTP_SECURE: secure,
  })
  console.log(t(lang, 'smtp.saved', { file: ENV_FILE }))
}

// ─── Baidu Maps section ────────────────────────────────────────────────

async function sectionBaidu(lang: Lang): Promise<void> {
  while (true) {
    console.log()
    console.log(t(lang, 'baidu.title'))
    console.log(t(lang, 'baidu.subtitle'))
    console.log(t(lang, 'baidu.howto'))
    console.log()
    const current = readEnvFile().IMHUB_BAIDU_MAP_AK
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
      unsetEnvKey('IMHUB_BAIDU_MAP_AK')
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
    updateEnvFile({ IMHUB_BAIDU_MAP_AK: ak })
    console.log(t(lang, 'baidu.saved', { file: ENV_FILE }))
  }
}

// Suppress an unused-import warning for yesNo — exposed for future sections.
void yesNo
