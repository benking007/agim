// config-api — REST surface for agent configuration.
// Extracted from server.ts; follows the dispatcher pattern used by mcp-api.ts.
//
// Endpoints:
//   GET  /api/config              → full config (masked secrets) — admin only
//   PUT  /api/config              → merge + validate + persist    — admin only
//   GET  /api/agents/status       → { [name]: available }        — any auth

import type { IncomingMessage, ServerResponse } from 'node:http'
import { validateConfig } from '../core/config-schema.js'
import { updateConfigObject } from '../core/config-store.js'
import { loadConfig, type Config } from '../core/onboarding.js'
import { registry } from '../core/registry.js'
import {
  DEFAULT_AGENT_PROFILES,
  agentProfileOverridesFromEffective,
  mergeAgentProfiles,
  readAgentProfileOverrides,
  type AgentProfile,
} from '../core/agent-profiles.js'
import { isMasked } from './env-mask.js'
import { readBody, sendJson, sendError } from './http-utils.js'
import { requireAdmin, getRequestActor } from './auth.js'

class ConfigValidationError extends Error {
  constructor(readonly details: string[]) {
    super('Config validation failed')
    this.name = 'ConfigValidationError'
  }
}

/**
 * Match-and-handle dispatcher. Returns `true` when the request was
 * served; `false` when the URL/method didn't match.
 */
export async function handleConfigApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const p = url.pathname
  const m = req.method ?? 'GET'

  if (p === '/api/config' && m === 'GET') {
    if (!requireAdmin(req, res)) return true
    await handleGetConfig(req, res); return true
  }
  if (p === '/api/config' && m === 'PUT') {
    if (!requireAdmin(req, res)) return true
    await handlePutConfig(req, res); return true
  }
  if (p === '/api/agents/status' && m === 'GET') {
    await handleAgentsStatus(req, res); return true
  }
  return false
}

async function handleGetConfig(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const config = await loadConfig()
    const agentStatus = await getAgentStatuses()

    // Compliance gates — when the env flag is off, strip the
    // corresponding keys from the response so the settings UI never
    // sees them and renders no tabs / cards. On-disk config is left
    // untouched: flipping the env back on restores visibility.
    const { isGlobalImEnabled } = await import('../core/feature-flags.js')
    const showGlobalIm = isGlobalImEnabled()
    // v1.2.69 — IM platform blacklist. When an operator sets
    // AGIM_PLATFORM_BLACKLIST=telegram,discord (etc.), those platforms
    // are hidden from the admin SPA entirely — credentials still live
    // on disk but the UI shows nothing for that platform AND the
    // registry refuses to register the adapter at boot. Default empty.
    const { isPlatformBlacklisted: blocked } = await import('../core/registry.js')

    // v1.2.69 — strip blacklisted entries from the `messengers` array
    // so the SPA's per-platform toggle row also vanishes (rendered
    // from this array's values).
    //
    // v1.2.74 hotfix — the v1.2.69 implementation used
    // `Object.fromEntries(Object.entries(arr))`, which converts an
    // array into an index-keyed object `{ '0': 'telegram', '1': … }`.
    // The SPA then did `new Set(cfg.messengers ?? [])` and crashed
    // ("object is not iterable"). `config.messengers` is `string[]`
    // (see core/config-schema.ts:175), so a plain array filter is
    // the right shape.
    const visibleMessengers = config.messengers
      ? config.messengers.filter((name) => !blocked(name))
      : config.messengers

    const profileOverrides = readAgentProfileOverrides(config)
    const agentProfiles = mergeAgentProfiles(profileOverrides)

    sendJson(res, 200, {
      messengers: visibleMessengers,
      agents: config.agents,
      defaultAgent: config.defaultAgent,
      /** Effective specialty profiles (defaults ⊕ config overrides). */
      agentProfiles,
      /** Builtin defaults — Settings「恢复默认」用. */
      agentProfileDefaults: DEFAULT_AGENT_PROFILES,
      telegram: showGlobalIm && config.telegram && !blocked('telegram')
        ? { botToken: mask(config.telegram.botToken), channelId: config.telegram.channelId }
        : undefined,
      feishu: config.feishu && !blocked('feishu')
        ? { appId: config.feishu.appId, appSecret: mask(config.feishu.appSecret) }
        : undefined,
      dingtalk: config.dingtalk && !blocked('dingtalk')
        ? {
            clientId: config.dingtalk.clientId,
            clientSecret: mask(config.dingtalk.clientSecret),
            channelId: config.dingtalk.channelId,
            // v1.2.37 (batch 1) — surface policy + ack-reaction
            dmPolicy: config.dingtalk.dmPolicy,
            groupPolicy: config.dingtalk.groupPolicy,
            allowFrom: config.dingtalk.allowFrom,
            groupAllowFrom: config.dingtalk.groupAllowFrom,
            ackReaction: config.dingtalk.ackReaction,
            // v1.2.40 (batch 4) — surface accounts dict for read-only
            // listing. clientSecret is masked per-entry; clientId left
            // visible because operators rely on it to identify the bot.
            accounts: config.dingtalk.accounts
              ? Object.fromEntries(
                  Object.entries(config.dingtalk.accounts).map(([id, a]) => [id, {
                    name: a.name,
                    clientId: a.clientId,
                    clientSecret: mask(a.clientSecret),
                    enabled: a.enabled,
                  }]),
                )
              : undefined,
          }
        : undefined,
      discord: showGlobalIm && config.discord && !blocked('discord')
        ? {
            botToken: mask(config.discord.botToken),
            channelId: config.discord.channelId,
            allowedGuilds: config.discord.allowedGuilds,
            allowedChannels: config.discord.allowedChannels,
          }
        : undefined,
      // Feature flags surfaced for the SPA so it can hide the
      // corresponding tabs / nav entries. Field names are
      // intentionally neutral — they don't reveal which IMs / agent
      // types the flag controls beyond what the settings page
      // already exposes.
      features: {
        globalIm: showGlobalIm,
        // v1.2.71 — surface the live blacklist set so the SPA can hide
        // PlatformCards for blacklisted platforms. Without this the
        // backend filter on `messengers` / `telegram` / `feishu` etc.
        // only emptied the data but the hardcoded cards still rendered.
        blacklistedPlatforms: (await import('../core/registry.js')).getPlatformBlacklist(),
      },
      webPort: config.webPort,
      agentStatus,
    })
  } catch (_err) {
    sendJson(res, 500, { error: 'Failed to load config' })
  }
}

async function handlePutConfig(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req, res)
    const incoming = JSON.parse(body) as Record<string, unknown>
    // Compliance gates — silently drop keys the operator's deployment
    // is not allowed to surface. We don't 4xx here because the SPA may
    // round-trip a stale snapshot that happens to include these keys;
    // dropping them keeps existing on-disk values untouched (the
    // round-trip becomes a no-op for that field).
    //
    // We also scrub `messengers[]` so a hidden slot can't be toggled
    // via direct PUT (the SPA filters in render but a stale draft from
    // before the env flag was disabled would otherwise re-add the
    // entry on next save).
    const { isGlobalImEnabled } = await import('../core/feature-flags.js')
    if (!isGlobalImEnabled()) {
      delete incoming.telegram
      delete incoming.discord
      if (Array.isArray(incoming.messengers)) {
        incoming.messengers = (incoming.messengers as unknown[])
          .filter((m) => m !== 'telegram' && m !== 'discord')
      }
    }
    delete incoming.acpAgents
    delete incoming.acpDiscoveryUrls
    delete incoming.acpPort

    const { config: storedConfig } = await updateConfigObject((current) => {
      const existing = {
        messengers: [],
        agents: [],
        defaultAgent: 'agim',
        ...current,
      } as Config
      const merged: Record<string, unknown> = { ...existing }

    for (const key of Object.keys(incoming)) {
      const val = incoming[key]

      // Deep-protect nested known-masked paths so `ab****yz` never overwrites true value
      if (key === 'telegram' && typeof val === 'object' && val !== null) {
        const t = val as Record<string, unknown>
        merged.telegram = {
          ...(existing.telegram || {}),
          ...t,
          botToken: typeof t.botToken === 'string' && isMasked(t.botToken) ? existing.telegram?.botToken : t.botToken,
        }
        continue
      }
      if (key === 'feishu' && typeof val === 'object' && val !== null) {
        const f = val as Record<string, unknown>
        merged.feishu = {
          ...(existing.feishu || {}),
          ...f,
          appSecret: typeof f.appSecret === 'string' && isMasked(f.appSecret) ? existing.feishu?.appSecret : f.appSecret,
        }
        continue
      }
      if (key === 'dingtalk' && typeof val === 'object' && val !== null) {
        const d = val as Record<string, unknown>
        // v1.2.41 (batch 4 follow-up) — preserve clientSecret per-account when
        // the SPA echoes back the masked placeholder.
        let mergedAccounts: Record<string, Record<string, unknown>> | undefined
        if (d.accounts && typeof d.accounts === 'object') {
          mergedAccounts = {}
          const existingAccts = (existing.dingtalk?.accounts || {}) as Record<string, { clientSecret?: string }>
          for (const [accId, raw] of Object.entries(d.accounts as Record<string, Record<string, unknown>>)) {
            const incomingSecret = typeof raw.clientSecret === 'string' ? raw.clientSecret : undefined
            const keep = incomingSecret !== undefined && isMasked(incomingSecret)
            mergedAccounts[accId] = {
              ...raw,
              clientSecret: keep ? existingAccts[accId]?.clientSecret : incomingSecret,
            }
          }
        }
        merged.dingtalk = {
          ...(existing.dingtalk || {}),
          ...d,
          clientSecret: typeof d.clientSecret === 'string' && isMasked(d.clientSecret) ? existing.dingtalk?.clientSecret : d.clientSecret,
          ...(mergedAccounts !== undefined ? { accounts: mergedAccounts } : {}),
        }
        continue
      }
      if (key === 'discord' && typeof val === 'object' && val !== null) {
        const d = val as Record<string, unknown>
        merged.discord = {
          ...(existing.discord || {}),
          ...d,
          botToken: typeof d.botToken === 'string' && isMasked(d.botToken) ? existing.discord?.botToken : d.botToken,
        }
        continue
      }
      if (key === 'agentProfiles' && typeof val === 'object' && val !== null && !Array.isArray(val)) {
        // SPA sends effective profiles; persist sparse overrides vs builtins.
        const effective = mergeAgentProfiles(val as Record<string, Partial<AgentProfile>>)
        merged.agentProfiles = agentProfileOverridesFromEffective(effective)
        continue
      }
      // Read-only companion field from GET — never persist.
      if (key === 'agentProfileDefaults') continue
      if (typeof val === 'string' && isMasked(val)) {
        continue
      }
      merged[key] = val
    }

      const result = validateConfig(merged)
      if (!result.ok) throw new ConfigValidationError(result.errors)
      return {
        config: result.config as unknown as Record<string, unknown>,
        result: undefined,
      }
    }, {
      fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
    })
    // v1.2.103 — propagate the new config to the live-config singleton.
    // Without this, the SPA's "enabled agents" / "default agent" toggles
    // were persisted to disk but the running process kept its boot-time
    // snapshot until a service restart. registry filters + routeCtx now
    // pick up the change on the very next request.
    try {
      const { setLiveConfig } = await import('../core/live-config.js')
      setLiveConfig(storedConfig as unknown as Config)
    } catch { /* best-effort — old configs without live-config still work */ }
    // R12 ⑤ — persistent audit. `details.keys` is the list of top-level
    // config keys touched (e.g. ['feishu', 'discord']) — never the raw
    // values, which would leak tokens / app secrets through the audit
    // table.
    try {
      const { logAuditEvent } = await import('../core/audit-log.js')
      logAuditEvent({
        eventType: 'config.put',
        actor: getRequestActor(req),
        outcome: 'ok',
        details: { keys: Object.keys(incoming) },
      })
    } catch { /* best-effort */ }
    sendJson(res, 200, { ok: true })
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      sendError(res, 400, 'CONFIG_INVALID', {
        message: err.message,
        extra: { details: err.details },
      })
      return
    }
    const msg = err instanceof Error ? err.message : String(err)
    sendError(res, 400, 'CONFIG_SAVE_FAILED', { detail: msg })
  }
}

async function handleAgentsStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const agentStatus = await getAgentStatuses()
    sendJson(res, 200, agentStatus)
  } catch (_err) {
    sendJson(res, 500, { error: 'Failed to check agents' })
  }
}

export async function getAgentStatuses(): Promise<Record<string, boolean>> {
  const agents = registry.listAgents()
  const status: Record<string, boolean> = {}
  await Promise.all(
    agents.map(async (name) => {
      const agent = registry.findAgent(name)
      if (agent) {
        try {
          status[name] = await agent.isAvailable()
        } catch {
          status[name] = false
        }
      }
    })
  )
  return status
}

function mask(value: string | undefined): string {
  if (!value) return ''
  if (value.length <= 4) return '****'
  return `${value.slice(0, 2)}****${value.slice(-2)}`
}
