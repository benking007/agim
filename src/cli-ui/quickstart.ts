// cli-ui/quickstart.ts — implementation behind `agim go`.
// CLI starts the service and opens the browser; first-run configuration
// happens in the /setup wizard. `agim config` / setup-llm stay as the
// advanced path.

import { loadConfig, saveConfigChanges, type Config } from '../core/onboarding.js'
import { markSetupSkipped } from '../core/onboarding-status.js'
import { UserAbortError } from './prompts.js'
import { t, resolveCliLang, type Lang } from './i18n.js'
import { checkAgentsFresh, pickPreferredAgent } from './readiness.js'
import { offerServiceStart } from './cmd-handlers.js'

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

export async function runQuickstart(lang: Lang = resolveCliLang()): Promise<void> {
  console.log()
  console.log(t(lang, 'go.title'))
  console.log('='.repeat(34))
  console.log(t(lang, 'go.goal'))

  try {
    const { purgeRetiredAcpResidue } = await import('./retire-acp-residue.js')
    await purgeRetiredAcpResidue()
  } catch { /* best-effort */ }

  try {
    let config = await loadConfig()
    const readiness = await checkAgentsFresh(config)
    const preferred = pickPreferredAgent(readiness.available, config.defaultAgent)

    if (!preferred) {
      console.log()
      console.log(t(lang, 'go.started'))
      await offerServiceStart(lang, { path: '/setup', open: true, assumeYes: true })
      console.log()
      console.log(t(lang, 'go.next_setup'))
      console.log(t(lang, 'go.bootstrap_hint'))
      console.log(t(lang, 'go.web_later'))
      return
    }

    const next = ensureAgentSelected(config, preferred)
    if (JSON.stringify(next) !== JSON.stringify(config)) {
      config = await saveConfigChanges(config, next)
    }

    console.log()
    console.log(t(lang, 'go.default_agent', { agent: preferred }))
    if ((config.messengers?.length ?? 0) === 0) {
      console.log(t(lang, 'go.web_only'))
    }

    await offerServiceStart(lang, { welcome: true })
    console.log()
    console.log(t(lang, 'go.next_chat'))
    console.log(t(lang, 'go.web_later'))
  } catch (err) {
    if (err instanceof UserAbortError) {
      try { await markSetupSkipped() } catch { /* best-effort */ }
      console.log(t(lang, 'go.aborted_skip'))
      return
    }
    throw err
  }
}
