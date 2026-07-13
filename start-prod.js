#!/usr/bin/env node
// Production "headless" entrypoint.
//
// Differences from `dist/cli.js start`:
//   - Skips the interactive onboarding (no readline prompts).
//   - Skips the messenger startup (Telegram/WeChat/Feishu) — this script
//     is intended for deployments that only expose the Web/REST/ACP
//     surfaces. Set AGIM_ENABLE_MESSENGERS=1 to opt in.
//
// Everything else mirrors cli.ts: load config, plugins, ACP agents,
// auto-discovery, scheduler, audit retention sweep — so /api/jobs,
// /schedule, /audit etc. all work identically to the CLI flow.

import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const here = dirname(fileURLToPath(import.meta.url))

const { registry } = await import(join(here, 'dist/core/registry.js'))
const { sessionManager } = await import(join(here, 'dist/core/session.js'))
const { workspaceRegistry } = await import(join(here, 'dist/core/workspace.js'))
const { startWebServer } = await import(join(here, 'dist/web/server.js'))
const { startACPServer } = await import(join(here, 'dist/core/acp-server.js'))
const { loadConfig } = await import(join(here, 'dist/core/onboarding.js'))
const { startScheduler } = await import(join(here, 'dist/core/schedule.js'))
const { logger } = await import(join(here, 'dist/core/logger.js'))

const log = logger.child({ component: 'start-prod' })

const { migrateNamingV2, getTenantsFromConfig, migratePiSessionsDir, migrateSessionAgentIds, migrateAgentWorkspaceDir } = await import(join(here, 'dist/core/naming-migrate.js'))
const { saveConfig } = await import(join(here, 'dist/core/onboarding.js'))

let config = await loadConfig()
{
  const step = migrateNamingV2(config)
  if (step.changed) {
    await saveConfig(step.config)
    config = step.config
  }
}
migratePiSessionsDir()
migrateSessionAgentIds()
migrateAgentWorkspaceDir()

const defaultAgent = config.defaultAgent || 'claude-code'
const webPort = config.webPort || 3000
const acpPort = config.acpPort || 9090

await sessionManager.start()
await registry.loadBuiltInPlugins()

const tenants = getTenantsFromConfig(config)
if (tenants.length > 0) {
  workspaceRegistry.load({ workspaces: tenants })
} else {
  workspaceRegistry.load({})
}

if (Array.isArray(config.acpAgents) && config.acpAgents.length > 0) {
  await registry.loadACPAgents(config.acpAgents)
}
if (Array.isArray(config.acpDiscoveryUrls) && config.acpDiscoveryUrls.length > 0) {
  await registry.loadDiscoveredACPAgents(config.acpDiscoveryUrls)
}

// Optional: enable IM messengers when explicitly requested. cli.ts has
// the full onboarding flow for new users; here we only wire the ones
// already configured so a misconfigured machine doesn't crash boot.
if (process.env.AGIM_ENABLE_MESSENGERS === '1') {
  for (const name of config.messengers || []) {
    const messenger = registry.getMessenger(name)
    if (messenger) {
      try {
        await messenger.start()
        log.info({ messenger: name }, 'Messenger started')
      } catch (err) {
        log.error({ messenger: name, err: err instanceof Error ? err.message : String(err) },
          'Messenger failed to start, skipping')
      }
    } else {
      log.warn({ messenger: name }, 'Configured messenger not registered, skipping')
    }
  }
}

startScheduler()

await startWebServer({ port: webPort, defaultAgent })
await startACPServer({ port: acpPort, defaultAgent })

log.info({ webPort, acpPort, defaultAgent, agents: registry.listAgents().length },
  'agim headless started')
