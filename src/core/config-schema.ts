// Config schema validation using zod

import { z } from 'zod'

const safeNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

const acpAgentSchema = z.object({
  name: z.string().min(1).regex(safeNamePattern, 'Agent name must be alphanumeric (with . _ - allowed)'),
  aliases: z.array(z.string()).optional(),
  endpoint: z.string().min(1),
  auth: z.object({
    type: z.enum(['none', 'apikey', 'bearer']),
    token: z.string().optional(),
  }).optional(),
  enabled: z.boolean().optional(),
})

const telegramSchema = z.object({
  botToken: z.string().min(1),
  channelId: z.string().optional(),
})

const feishuSchema = z.object({
  appId: z.string().min(1),
  appSecret: z.string().min(1),
  channelId: z.string().optional(),
})

const discordSchema = z.object({
  botToken: z.string().min(1),
  channelId: z.string().optional(),
  allowedGuilds: z.array(z.string()).optional(),
  allowedChannels: z.array(z.string()).optional(),
})

export const configSchema = z.object({
  messengers: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  defaultAgent: z.string().default('claude-code'),
  telegram: telegramSchema.optional(),
  feishu: feishuSchema.optional(),
  discord: discordSchema.optional(),
  acpAgents: z.array(acpAgentSchema).optional(),
  /** Base URLs to probe for `.well-known/acp` at startup. */
  acpDiscoveryUrls: z.array(z.string().url()).optional(),
  webPort: z.number().int().positive().optional(),
  acpPort: z.number().int().positive().optional(),
  workspaces: z.array(z.object({
    id: z.string().min(1),
    name: z.string().default(''),
    agents: z.array(z.string()).default([]),
    members: z.array(z.string()).optional(),
    rateLimit: z.object({
      rate: z.number().int().positive(),
      intervalSec: z.number().int().positive(),
      burst: z.number().int().positive(),
    }).optional(),
  })).optional(),
}).passthrough()

export type ValidatedConfig = z.infer<typeof configSchema>

export function validateConfig(data: unknown):
  { ok: true; config: ValidatedConfig; errors: string[] } | { ok: false; config: ValidatedConfig; errors: string[] }
{
  const result = configSchema.safeParse(data)
  if (result.success) {
    return { ok: true, config: result.data, errors: [] }
  }
  const errors = result.error.issues.map(issue => {
    const path = issue.path.join('.') || '(root)'
    return `${path}: ${issue.message}`
  })
  // Best-effort: strip invalid fields and re-parse with defaults so the
  // caller always gets a structurally valid config. If even that fails,
  // fall back to schema defaults (empty config).
  const sanitized = { ...(data && typeof data === 'object' ? data : {}) }
  for (const issue of result.error.issues) {
    if (issue.path.length === 1) {
      delete (sanitized as Record<string, unknown>)[String(issue.path[0])]
    }
  }
  const retry = configSchema.safeParse(sanitized)
  const config = retry.success ? retry.data : configSchema.parse({})
  return { ok: false, config, errors }
}
