// cli-ui/quickstart.ts — implementation behind `agim go`. The goal is not to
// expose every knob; it gets a user to "Web console can talk to an agent"
// and leaves IM / systemd / workspaces for progressive discovery.

import { loadConfig, saveConfigChanges, type Config } from '../core/onboarding.js'
import { menu, BACK, UserAbortError } from './prompts.js'
import { t, resolveCliLang, formatAgentInstallHint, type Lang } from './i18n.js'
import { checkAgentsFresh, pickPreferredAgent } from './readiness.js'
import { offerServiceStart } from './cmd-handlers.js'

function text(lang: Lang, zh: string, en: string): string {
  return lang === 'zh' ? zh : en
}

function ensureAgentSelected(config: Config, agent: string): Config {
  const agents = new Set(config.agents ?? [])
  agents.add(agent)
  return {
    ...config,
    agents: Array.from(agents),
    defaultAgent: agent,
    messengers: config.messengers ?? [],
  }
}

async function configureNativeAgent(lang: Lang): Promise<boolean> {
  const { runSetupLlm } = await import('./setup-llm.js')
  console.log()
  console.log(text(lang, '我们先配置 Agim Agent 的大模型 API。', 'Let us configure the model API for Agim Agent first.'))
  const addCode = await runSetupLlm(['add'])
  if (addCode !== 0) return false
  const enableCode = await runSetupLlm(['native-enable'])
  return enableCode === 0
}

export async function runQuickstart(lang: Lang = resolveCliLang()): Promise<void> {
  console.log()
  console.log(text(lang, 'Agim Go', 'Agim Go'))
  console.log('='.repeat(34))
  console.log(text(
    lang,
    '目标：先跑通 Web 控制台和一次 Agent 对话，IM 接入与服务器部署稍后再做。',
    'Goal: get the Web console and one agent conversation working first. IM and server deployment can come later.',
  ))

  // Older installs may still carry acpPort / AGIM_ACP_BIND — strip before
  // the first-run path talks about ports.
  try {
    const { purgeRetiredAcpResidue } = await import('./retire-acp-residue.js')
    await purgeRetiredAcpResidue()
  } catch { /* best-effort */ }

  let config = await loadConfig()
  let readiness = await checkAgentsFresh(config)
  let preferred = pickPreferredAgent(readiness.available, config.defaultAgent)

  if (!preferred) {
    console.log()
    console.log(text(
      lang,
      '还没有可用的 Agent。你可以配置 Agim Agent（只需要一个大模型 API key），也可以先安装 Claude Code / Codex。',
      'No usable agent is available yet. You can configure Agim Agent with one model API key, or install Claude Code / Codex first.',
    ))
    let action: 'agim' | 'install' | 'advanced' | 'doctor' | typeof BACK
    try {
      action = await menu<'agim' | 'install' | 'advanced' | 'doctor'>({
        lang,
        message: t(lang, 'menu.subtitle'),
        choices: [
          { value: 'agim', name: text(lang, '配置 Agim Agent 大模型 API（推荐）', 'Configure Agim Agent model API (recommended)') },
          { value: 'install', name: text(lang, '查看 Agent CLI 安装命令', 'Show Agent CLI install commands') },
          { value: 'doctor', name: text(lang, '先运行本机体检', 'Run local doctor first') },
          { value: 'advanced', name: text(lang, '进入完整配置菜单', 'Open full configuration menu'), separatorBefore: true },
        ],
      })
    } catch (err) {
      if (err instanceof UserAbortError) return
      throw err
    }
    if (action === BACK) return
    if (action === 'install') {
      console.log()
      console.log(formatAgentInstallHint(lang, readiness.missing))
      console.log()
      console.log(text(lang, '安装并登录其中一个 Agent 后，再运行 agim go。', 'After installing and signing in to one agent, run agim go again.'))
      return
    }
    if (action === 'doctor') {
      const { runDoctor } = await import('./doctor.js')
      await runDoctor()
      return
    }
    if (action === 'advanced') {
      const { runConfigWizard } = await import('./config-wizard.js')
      await runConfigWizard(lang)
      return
    }
    const ok = await configureNativeAgent(lang)
    if (!ok) {
      console.log(text(lang, 'Agim Agent 尚未配置完成。', 'Agim Agent setup did not complete.'))
      return
    }
    config = await loadConfig()
    readiness = await checkAgentsFresh(config)
    preferred = pickPreferredAgent(readiness.available, config.defaultAgent)
  }

  if (!preferred) {
    console.log(text(lang, '仍然没有可用 Agent。请运行 agim doctor 查看原因。', 'Still no usable agent. Run agim doctor for details.'))
    return
  }

  const next = ensureAgentSelected(config, preferred)
  if (JSON.stringify(next) !== JSON.stringify(config)) {
    config = await saveConfigChanges(config, next)
  }

  console.log()
  console.log(text(lang, `默认 Agent：${preferred}`, `Default agent: ${preferred}`))
  if ((config.messengers?.length ?? 0) === 0) {
    console.log(text(lang, 'IM 暂不配置：首次体验会以 Web-only 模式运行。', 'No IM configured yet: first use will run in web-only mode.'))
  }

  await offerServiceStart(lang, { welcome: true })
  console.log()
  console.log(text(lang, '下一步：在 Web 控制台发第一条消息；跑通后再到 Settings 连接微信 / 飞书 / 钉钉。', 'Next: send the first message in the Web console; after it works, connect WeChat / Feishu / DingTalk from Settings.'))
  console.log(text(lang, '以后忘记入口或 token，就运行：agim web', 'Later, if you forget the URL or token path, run: agim web'))
}
