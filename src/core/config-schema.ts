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

/**
 * Native LLM backend (Stage 1 of the D+ plan, 2026-05-23).
 *
 * Each entry describes one OpenAI/Anthropic-compatible API endpoint
 * agim can talk to *directly* (without spawning a CLI agent). Used by
 * internal introspection callers (memory-distill / memory-consolidate /
 * intent-llm now; heartbeat evaluator + native chat agent later).
 *
 * The API key is NOT stored here — secrets live in
 * `~/.agim/llm-secrets.json` (or the AGIM_LLM_SECRET_<NAME> env). See
 * src/core/llm/secrets.ts.
 *
 * Stage 1 ships only `provider: 'openai-compat'`. Anthropic native +
 * Ollama land in Stage 2.
 */
const llmBackendSchema = z.object({
  /** Backend identifier referenced by llmRoles. Must be unique within
   *  the array; the registry de-duplicates with a `last wins` rule and
   *  logs a warning on collision. Match safeNamePattern so it's safe to
   *  shove into the AGIM_LLM_SECRET_<NAME> env var suffix. */
  name: z.string().min(1).regex(safeNamePattern,
    'LLM backend name must be alphanumeric (with . _ - allowed)'),
  /** Transport / dialect. Stage 1: only openai-compat. */
  provider: z.enum(['openai-compat']),
  /** Default model id. Caller may override per call via ChatOptions.model. */
  model: z.string().min(1),
  /** Full base URL up to (but not including) `/chat/completions`.
   *  Optional — when omitted, the OpenAI-compat provider defaults to
   *  https://api.openai.com/v1. */
  baseUrl: z.string().url().optional(),
  /** Display label for the cost dashboard / logs. Lets DeepSeek and Kimi
   *  show up under their own brand instead of all under "openai-compat". */
  label: z.string().optional(),
  /** Extra HTTP headers — OpenRouter (`HTTP-Referer` / `X-Title`), Azure
   *  (`api-key`), private gateways. Authorization is set by the provider
   *  and is NOT overridable here on purpose. */
  extraHeaders: z.record(z.string(), z.string()).optional(),
  /** Default temperature (provider default 0.3 — we want deterministic
   *  JSON for introspection callers, not creativity). */
  temperature: z.number().min(0).max(2).optional(),
  /** Default max output tokens (provider default 1024). */
  maxTokens: z.number().int().positive().optional(),
  /** Number of retries on transient (429 / 5xx). Provider default 1. */
  retryOnTransient: z.number().int().min(0).max(5).optional(),
  /** Soft kill-switch — set false to keep the row around but make
   *  registry.getProvider() pretend it doesn't exist. */
  enabled: z.boolean().optional(),
})

/**
 * Role → backend-name mapping. Roles are operational concepts agim
 * internal callers ask for ("give me a cheap JSON-grade backend" /
 * "give me an evaluator-grade backend"). Multiple roles may resolve to
 * the same backend. Stage 1 recognises: cheap, evaluator, native-chat.
 * Unknown keys are accepted for forward compatibility.
 */
const llmRolesSchema = z.record(z.string(), z.string())

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
  /** D+ Stage 1: native LLM backends (OpenAI-compat now, Anthropic /
   *  Ollama in Stage 2). Optional — when absent the registry returns
   *  no providers and every caller falls back to its CLI agent path. */
  llmBackends: z.array(llmBackendSchema).optional(),
  /** D+ Stage 1: role → backend-name map. See llmRolesSchema. */
  llmRoles: llmRolesSchema.optional(),
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
