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
 * External MCP (Model Context Protocol) server to attach (Stage 2 of
 * the D+ plan, sub-PR #2). Discovered tools are exposed to the native
 * agent loop via the LLM registry's MCP layer; they're independent of
 * llmBackends (it's perfectly fine to configure mcpServers without any
 * llmBackends, and the CLI agents can also use them through their own
 * MCP configs).
 *
 * Transport selection:
 *   - `command` present     -> stdio (spawn subprocess)
 *   - `url` ends with /sse  -> SSE
 *   - `url` otherwise       -> streamable HTTP (the modern transport)
 *
 * Tools discovered at startup are passed to the native agent loop as
 * `ToolDef[]`; tool names get the `mcp_{server}_` prefix to dodge
 * collisions when multiple servers expose the same tool name. See
 * src/core/llm/mcp-client.ts.
 */
const mcpServerSchema = z.object({
  /** Server identifier, unique within mcpServers[]. Used as the
   *  tool-name prefix; must be alphanumeric (with . _ - allowed). */
  name: z.string().min(1).regex(safeNamePattern,
    'MCP server name must be alphanumeric (with . _ - allowed)'),
  /** stdio: executable to spawn. Mutually exclusive with `url`. */
  command: z.string().min(1).optional(),
  /** stdio: positional args. Ignored when `command` is absent. */
  args: z.array(z.string()).optional(),
  /** stdio: extra env merged onto the child process env. */
  env: z.record(z.string(), z.string()).optional(),
  /** stdio: cwd for the child. Defaults to agim's cwd. */
  cwd: z.string().optional(),
  /** http/sse: target URL. Mutually exclusive with `command`.
   *  URLs ending with /sse use the SSE transport; everything else uses
   *  streamable HTTP. */
  url: z.string().url().optional(),
  /** http/sse: extra headers (Authorization, custom auth tokens, …). */
  headers: z.record(z.string(), z.string()).optional(),
  /** Per-tool-call hard timeout (ms). Default 30s. */
  toolTimeoutMs: z.number().int().positive().optional(),
  /** Filter the tool set the server advertises. ['*'] = all tools (the
   *  default). Otherwise only tools whose original OR namespaced name
   *  is in the list are registered. */
  enabledTools: z.array(z.string()).optional(),
  /** Soft kill-switch — set false to keep the row around without
   *  attempting to connect at startup. */
  enabled: z.boolean().optional(),
}).superRefine((cfg, ctx) => {
  // Either `command` or `url` must be set; never both.
  const hasCmd = typeof cfg.command === 'string' && cfg.command.length > 0
  const hasUrl = typeof cfg.url === 'string' && cfg.url.length > 0
  if (hasCmd === hasUrl) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'mcpServer entries must set exactly one of `command` (stdio) or `url` (http/sse)',
    })
  }
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
  /** Transport / dialect. Supported: openai-compat (OpenAI / DeepSeek /
   *  Moonshot / Qwen / Ollama / vLLM / OpenRouter / ...), anthropic
   *  (Anthropic Messages API). */
  provider: z.enum(['openai-compat', 'anthropic']),
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

/** Loose storage shape — strict credential checks run in superRefine only
 *  when the platform is listed in `messengers[]`. */
const telegramLooseSchema = z.object({
  botToken: z.string().optional(),
  channelId: z.string().optional(),
}).passthrough().optional()

const feishuLooseSchema = z.object({
  appId: z.string().optional(),
  appSecret: z.string().optional(),
  channelId: z.string().optional(),
}).passthrough().optional()

const discordLooseSchema = z.object({
  botToken: z.string().optional(),
  channelId: z.string().optional(),
  allowedGuilds: z.array(z.string()).optional(),
  allowedChannels: z.array(z.string()).optional(),
}).passthrough().optional()

export const configSchema = z.object({
  messengers: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
  defaultAgent: z.string().default('agim'),
  telegram: telegramLooseSchema,
  feishu: feishuLooseSchema,
  discord: discordLooseSchema,
  acpAgents: z.array(acpAgentSchema).optional(),
  /** Base URLs to probe for `.well-known/acp` at startup. */
  acpDiscoveryUrls: z.array(z.string().url()).optional(),
  webPort: z.number().int().min(1).max(65_535).optional(),
  acpPort: z.number().int().min(1).max(65_535).optional(),
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
  /** Naming v2: preferred field for access-rule scopes (alias of workspaces). */
  tenants: z.array(z.object({
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
  /** Boot migration flags (idempotent). */
  nativeAgentToggleMigrated: z.boolean().optional(),
  agimAgentIdMigrated: z.boolean().optional(),
  tenantsFieldMigrated: z.boolean().optional(),
  /** D+ Stage 1: native LLM backends (OpenAI-compat now, Anthropic /
   *  Ollama in Stage 2). Optional — when absent the registry returns
   *  no providers and every caller falls back to its CLI agent path. */
  llmBackends: z.array(llmBackendSchema).optional(),
  /** D+ Stage 1: role → backend-name map. See llmRolesSchema. */
  llmRoles: llmRolesSchema.optional(),
  /** D+ Stage 2 sub-PR #2: external MCP servers to attach. Their tools
   *  are exposed to the native agent loop. Optional — when absent, only
   *  the built-in agim MCP server's tools (mcp__agim__*) are available
   *  to the native agent. */
  mcpServers: z.array(mcpServerSchema).optional(),
}).passthrough().superRefine((cfg, ctx) => {
  const enabled = new Set(cfg.messengers ?? [])

  if (enabled.has('telegram')) {
    const r = telegramSchema.safeParse(cfg.telegram ?? {})
    if (!r.success) {
      for (const issue of r.error.issues) {
        ctx.addIssue({ ...issue, path: ['telegram', ...issue.path] })
      }
    }
  }
  if (enabled.has('feishu')) {
    const r = feishuSchema.safeParse(cfg.feishu ?? {})
    if (!r.success) {
      for (const issue of r.error.issues) {
        ctx.addIssue({ ...issue, path: ['feishu', ...issue.path] })
      }
    }
  }
  if (enabled.has('discord')) {
    const r = discordSchema.safeParse(cfg.discord ?? {})
    if (!r.success) {
      for (const issue of r.error.issues) {
        ctx.addIssue({ ...issue, path: ['discord', ...issue.path] })
      }
    }
  }
})

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
  // Best-effort recovery works at top-level ownership boundaries. A broken
  // workspace entry should disable the workspace config, not erase unrelated
  // agents, messengers, and defaults. Credential errors also remove the
  // affected messenger from the enabled list so the sanitized config can be
  // parsed without repeatedly failing the cross-field refinement.
  const sanitized: Record<string, unknown> = {
    ...(data && typeof data === 'object' && !Array.isArray(data)
      ? data as Record<string, unknown>
      : {}),
  }
  const invalidRoots = new Set<string>()
  for (const issue of result.error.issues) {
    if (issue.path.length > 0) invalidRoots.add(String(issue.path[0]))
  }
  for (const root of invalidRoots) delete sanitized[root]

  const credentialRoots = new Set(['telegram', 'feishu', 'discord'])
  if (Array.isArray(sanitized.messengers)) {
    sanitized.messengers = sanitized.messengers.filter(
      (name): name is string => typeof name === 'string'
        && !(credentialRoots.has(name) && invalidRoots.has(name)),
    )
  }

  const retry = configSchema.safeParse(sanitized)
  // Root-level corruption is rare, but still preserve the two routing fields
  // that can be validated independently instead of taking the entire runtime
  // back to a fresh-install shape.
  const config = retry.success
    ? retry.data
    : configSchema.parse({
      agents: Array.isArray(sanitized.agents)
        ? sanitized.agents.filter((name): name is string => typeof name === 'string')
        : [],
      defaultAgent: typeof sanitized.defaultAgent === 'string'
        ? sanitized.defaultAgent
        : 'agim',
    })
  return { ok: false, config, errors }
}
