# Native LLM backends (D+ Stage 1)

> **Status**: Stage 1 of the D+ plan (see `/opt/cursor/artifacts/plans/nanobot_vs_agim_*.plan.md`).
> Ships in v1.3.0. CLI agent fallback is still the default — native backends
> are strictly **opt-in** and only used by internal introspection callers in
> this stage.

## What this is

agim's "agent brain" has historically been a third-party CLI (Claude Code / Codex / OpenCode) spawned per request. That's still the main path. **Native LLM backends** let agim talk directly to an OpenAI/Anthropic-compatible HTTP API for *internal* tasks where spawning a CLI is wasteful:

- `memory-distill` — extracts long-term facts from a (user msg, agent reply) turn
- `memory-consolidate` — daily rebuild of per-user persona summary
- `intent-llm` — picks an agent when the rule-based router is unsure

Wins:

- ~200ms per call instead of seconds (no CLI spawn)
- Costs a tenth (cheap models are fine for these JSON-out tasks)
- Lets you point agim at DeepSeek / Kimi / Qwen / Ollama / vLLM directly without waiting for upstream CLI support

What's **not** in Stage 1 (lands in later stages):

- ❌ Tool calling / agent loop (Stage 2)
- ❌ MCP client (Stage 2)
- ❌ A `native-chat` agent users can route to from IM (Stage 2)
- ❌ Configuration via `agim` CLI wizard or web UI (Stage 4)
- ❌ A/B evaluator + automatic fallback chain (Stage 5)

Stage 1 is plumbing; everything wires together in later stages.

## Configuration

Two pieces — both optional. When absent, every caller falls back to the existing CLI agent path and behaviour is unchanged.

### 1. `llmBackends` array in `~/.agim/config.json`

```json
{
  "llmBackends": [
    {
      "name": "deepseek-cheap",
      "provider": "openai-compat",
      "model": "deepseek-chat",
      "baseUrl": "https://api.deepseek.com/v1",
      "label": "deepseek",
      "temperature": 0.2,
      "maxTokens": 1024
    },
    {
      "name": "ollama-local",
      "provider": "openai-compat",
      "model": "qwen2.5:7b-instruct",
      "baseUrl": "http://localhost:11434/v1",
      "label": "ollama"
    }
  ],
  "llmRoles": {
    "cheap": "deepseek-cheap"
  }
}
```

Fields:

| field | required | notes |
|---|---|---|
| `name` | yes | Unique within the array; alphanumeric + `._-`. Used as the env-var suffix for the secret (see below). |
| `provider` | yes | `openai-compat` (OpenAI / DeepSeek / Moonshot / Qwen / Ollama / vLLM / OpenRouter / Together / Groq / SiliconFlow / Azure-compat) OR `anthropic` (Anthropic Messages API, since Stage 2 sub-PR #1). |
| `model` | yes | The default model id sent in every request. |
| `baseUrl` | no | Defaults to `https://api.openai.com/v1`. Strip the trailing `/chat/completions`; the provider appends it. |
| `label` | no | Display label for logs / future cost dashboard (e.g. `deepseek` / `kimi`). Defaults to `openai-compat`. |
| `extraHeaders` | no | Merged into every request. Useful for OpenRouter (`HTTP-Referer`, `X-Title`), Azure (`api-key`). `Authorization` is NOT overridable here — it's set automatically from the secret. |
| `temperature` | no | Default 0.3 (deterministic JSON). |
| `maxTokens` | no | Default 1024. |
| `retryOnTransient` | no | Number of retries on 408/429/5xx. Default 1. |
| `enabled` | no | Soft kill-switch. Default true. |

### 2. `llmRoles` map

Roles are operational concepts agim's internal callers ask for. Stage 1 + the #9 follow-up consume:

- `cheap` — distill / consolidate / intent-llm
- `evaluator` — notification-evaluator gate (see [Notification evaluator](#notification-evaluator-d-stage-1-follow-up-9) below)

Other role keys (`native-chat`, `native-coder`) are reserved for later stages and accepted by the schema for forward compatibility.

A role pointing at a backend that doesn't exist (or has no secret) is logged at warn level on startup but doesn't crash agim — the caller silently falls back to its CLI agent path.

### 3. Secret storage

API keys are **not** in `config.json`. Two precedence-ordered paths:

1. Environment variable `AGIM_LLM_SECRET_<UPPER_BACKEND_NAME>` (hyphens → underscores). Example: backend `deepseek-cheap` → `AGIM_LLM_SECRET_DEEPSEEK_CHEAP`. Wins over the file. Useful for systemd / CI / cloud-agent injection.
2. `~/.agim/llm-secrets.json` (mode `0600`):

   ```json
   {
     "version": 1,
     "keys": {
       "deepseek-cheap": "sk-...",
       "ollama-local": ""
     }
   }
   ```

   Stage 4 ships `agim config llm add` to write this file via wizard; for now, edit by hand (`chmod 600` after saving).

Backends with neither an env var nor a file entry are **silently skipped** at registry load with an info-level log line — `llm-registry.unconfigured`. Their roles dangle and callers fall back to CLI.

## Provider quick reference

All vendors below speak OpenAI's `/v1/chat/completions` schema; just plug in their base URL + an API key.

| vendor | baseUrl | env-var suffix example |
|---|---|---|
| OpenAI | (default) | `AGIM_LLM_SECRET_GPT` |
| DeepSeek | `https://api.deepseek.com/v1` | `AGIM_LLM_SECRET_DEEPSEEK_CHEAP` |
| Moonshot / Kimi | `https://api.moonshot.cn/v1` | `AGIM_LLM_SECRET_KIMI` |
| Qwen DashScope (compat) | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `AGIM_LLM_SECRET_QWEN` |
| Ollama (local) | `http://localhost:11434/v1` | — (Ollama doesn't require a key; pass any non-empty string) |
| vLLM (local) | `http://localhost:8000/v1` | — |
| OpenRouter | `https://openrouter.ai/api/v1` | `AGIM_LLM_SECRET_OPENROUTER` (also set `extraHeaders: { "HTTP-Referer": "https://your-host", "X-Title": "agim" }`) |
| Together | `https://api.together.xyz/v1` | `AGIM_LLM_SECRET_TOGETHER` |
| Groq | `https://api.groq.com/openai/v1` | `AGIM_LLM_SECRET_GROQ` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `AGIM_LLM_SECRET_SILICONFLOW` |
| Azure OpenAI | `https://<resource>.openai.azure.com/openai/deployments/<deployment>/openai` | set `extraHeaders: { "api-key": "..." }` instead of the standard secret (Azure doesn't use Bearer) |

## Auditing & cost tracking

Every introspection call records an `invocations` row with:

- `agent`: `llm:<backend-name>` (e.g. `llm:deepseek-cheap`) — lets the cost dashboard split CLI vs LLM spend
- `intent`: `memory.distill` / `memory.consolidate` / (future) `intent.fallback` / `heartbeat.evaluator`
- `cost`: USD reported by the provider, when available (OpenRouter reports it directly; most others don't)

`/api/metrics` and `/tasks#cost` aggregate over `agent` so a backend's volume + spend show up alongside CLI agents automatically.

## Fallback semantics

Every Stage-1 caller follows the same rule:

```text
if (llmBackend for 'cheap' role configured AND call succeeds):
    use the LLM result
else:
    spawn the user's CLI agent and proceed as before
```

So you can:

- Add `llmBackends` without re-deploying or restarting any other component
- Remove `llmBackends` and revert to pre-D+ behaviour with zero risk
- Mix: leave `cheap` configured for distill/consolidate but never enable `evaluator` / `native-chat` until you're comfortable

## Notification evaluator (D+ Stage 1 follow-up #9)

A configured `evaluator` role enables a small LLM gate that filters
**agent-initiated** outbound messages before they hit your IM. User
replies are never gated — only paths where an agent or scheduled job
decides on its own to ping you (the `push_message` MCP tool, future
heartbeat ticks, optionally `/api/notify`).

### Why

Long-running agent loops, monitoring jobs, and heartbeat ticks tend to
generate noisy "task done, nothing new" updates. The evaluator asks a
cheap model "is this actually worth pinging the user about?" and drops
routine chatter. Suppressions show up as `notification.suppress` rows
in `audit_events` so operators can sanity-check what's being filtered.

### Configuration

```bash
# 1. Master switch (default off — explicit opt-in)
export IMHUB_NOTIFICATION_EVALUATOR=on

# 2. Optional: pick which sources go through the gate. Defaults to
#    push,heartbeat. Comma-list. Valid: push,notify,reminder,heartbeat.
export IMHUB_NOTIFICATION_EVALUATOR_SOURCES=push,heartbeat,notify
```

Add an `evaluator` role mapping in `~/.agim/config.json`:

```json
{
  "llmBackends": [
    {
      "name": "evaluator-cheap",
      "provider": "openai-compat",
      "model": "deepseek-chat",
      "baseUrl": "https://api.deepseek.com/v1",
      "label": "deepseek"
    }
  ],
  "llmRoles": {
    "cheap": "evaluator-cheap",
    "evaluator": "evaluator-cheap"
  }
}
```

You can reuse the same backend as `cheap`, or point `evaluator` at a
slightly stronger model when you want fewer false suppressions. The
verdict prompt is tiny (~200 tokens out + ~30 tokens in) so cost is
negligible either way.

### Fail-open behaviour

The evaluator NEVER drops a message because the infrastructure broke.
Specifically:

| condition | result |
|---|---|
| `IMHUB_NOTIFICATION_EVALUATOR` not `on` | deliver, `via=disabled` |
| source not in gated set | deliver, `via=source-excluded` |
| no `evaluator` backend configured (or call failed) | deliver, `via=no-backend` |
| LLM returned unparseable text | deliver, `via=fail-open` |
| LLM said `deliver: true` | deliver, `via=evaluator` |
| LLM said `deliver: false` | **silently drop**, `via=evaluator` |

So flipping the switch on never loses messages unless the LLM actively
voted to suppress them. Cards (approval / recovery / choice) bypass
the gate entirely because they carry user actions.

### Auditing

Every suppression writes a row to `audit_events` with:

- `event_type = 'notification.suppress'`
- `actor = '<platform>:<userId>'` (or `'system'` for non-attributable sources)
- `target = '<platform>:<channelId>:<threadId>'`
- `details.source` — `'push'` / `'notify'` / `'heartbeat'` / `'reminder'`
- `details.backend` — which backend made the verdict
- `details.reason` — first 200 chars of the LLM's verdict reason
- `details.agent` — the calling agent's name (for push only)
- `details.textLen`

Query from `/tasks#audit` filter on event type, or programmatically:

```ts
import { queryAuditEvents } from './core/audit-log.js'
queryAuditEvents({ types: ['notification.suppress'], days: 7 })
```

### Tuning

If the gate suppresses too aggressively:

1. Look at recent `notification.suppress` rows — what messages are
   getting dropped?
2. Lower the temperature back to 0 (already default) and re-test
3. Switch to a stronger `evaluator` backend (e.g. gpt-4.1-mini instead
   of a 7B local model)
4. Disable selectively with `IMHUB_NOTIFICATION_EVALUATOR_SOURCES=heartbeat`
   to keep heartbeat gated but pass all push messages through
5. Last resort: `unset IMHUB_NOTIFICATION_EVALUATOR` to go back to
   pre-D+ behaviour with zero risk

## Heartbeat (proactive wake-up loop, P0 #1)

Beyond reminders (you ask for "remind me at 8am") and cron ("run /agent at
06:00 daily"), agim now offers **heartbeats**: an LLM-supervised periodic
loop that decides *whether anything is worth doing right now*, runs the
work via the user's CLI agent, and only pings the IM thread when the
result is actually actionable. Built on the LLM client + notification
evaluator from earlier follow-ups.

### Why

Cron is too dumb — you'll get pinged every tick regardless of whether
anything happened. Reminders are too one-shot — they don't carry an
ongoing intent across days. Heartbeats fit the middle gap: "every 30
min, check if my watchlist hit a stop-loss; if not, say nothing."

### Configuration

```bash
# 1. Master switch — without this no automatic ticks fire.
export IMHUB_HEARTBEAT_ENABLED=on

# 2. (Optional) Scheduler scan period. Default 60s; each row's own
#    interval (set per /heartbeat bind) is still honoured.
export IMHUB_HEARTBEAT_TICK_INTERVAL_MS=60000

# 3. (Optional) Default per-binding recurrence (minutes) for new
#    /heartbeat bind calls. Default 30 (matches nanobot). Users can
#    override per binding with /heartbeat interval N.
export IMHUB_HEARTBEAT_DEFAULT_INTERVAL_MIN=30
```

Also wire an `evaluator` role (recommended) and a `cheap` role:

```json
{
  "llmRoles": {
    "cheap": "evaluator-cheap",
    "evaluator": "evaluator-cheap"
  }
}
```

`cheap` powers the decide phase ("is there anything to do?"); `evaluator`
powers the gate at the end ("is the agent's output worth pinging the
user?"). They can share one backend.

### Slash commands

| command | what |
|---|---|
| `/heartbeat`                | show binding for this thread (or help) |
| `/heartbeat bind <body…>`   | create/replace binding; `body` is the markdown the LLM reasons against |
| `/heartbeat show`           | last tick status, recurrence, body preview |
| `/heartbeat interval 60`    | change recurrence (5–1440 minutes) |
| `/heartbeat run-now`        | fire one tick now (debug; still routed through evaluator) |
| `/heartbeat cancel` / `resume` | disable / re-enable this thread's binding |
| `/heartbeat list`           | every binding (admin only) |
| `/heartbeat status`         | scheduler enabled? running? scan period? |

### Tick flow

```
                    ┌─── DECIDE ────────────────────┐
                    │ cheap LLM reads body, answers │
   every N min ───▶ │ {run, summary} JSON           │
                    └──────┬──────────────┬─────────┘
                           │ run=false    │ run=true
                           ▼              ▼
                   ┌─ EXECUTE ────────────────────────┐
                   │ user's CLI agent runs summary;    │
                   │ NO_UPDATE sentinel = no result    │
                   └──────┬──────────────┬─────────────┘
                          │ NO_UPDATE    │ free-form text
                          ▼              ▼
                   ┌─ EVALUATE ───────────────────────┐
                   │ notification-evaluator gate       │
                   │ (source='heartbeat', default-on)  │
                   └──────┬──────────────┬─────────────┘
                          │ suppress     │ deliver
                          ▼              ▼
                       audit-log     sink.deliver()
                                     ↓
                                   user's IM
```

All five outcomes (`skipped`, `delivered`, `suppressed`, `no-agent`,
`failed`) are stamped onto the binding row so `/heartbeat show` always
knows what happened last tick.

### Failure modes & fail-open

| condition | result | rationale |
|---|---|---|
| no `cheap` backend | decide phase fail-opens to `run=true`, then execute path runs | better noisy than silent |
| decide LLM returns gibberish | same — fail-open | warn logged, manual debug via `/heartbeat run-now` |
| no CLI agent registered for thread | `status='no-agent'` (stamped + skipped) | new deployments see this until they configure an agent |
| agent returns `NO_UPDATE` sentinel | `status='skipped'` | no audit, no IM message |
| evaluator says deliver:false | `status='suppressed'` | audit-logged as `notification.suppress` |
| sink delivery throws | `status='failed'` | check outbox / messenger logs |

### Tuning

- **Per-thread recurrence**: shorter intervals (5–15 min) make sense for
  trading-hour monitors; longer (60–360 min) for daily summarisers.
- **Evaluator strictness**: if you want fewer suppressions, swap
  `evaluator` to a smarter model (e.g. gpt-4.1-mini instead of a 7B
  local model). Or `unset IMHUB_NOTIFICATION_EVALUATOR` to disable the
  gate entirely while keeping heartbeats.
- **Cost**: each tick is ~ (decide LLM call) + (execute CLI agent call)
  + (evaluator LLM call). If the agent is the dominant cost, reduce
  recurrence; if cheap LLMs are dominant, configure both `cheap` and
  `evaluator` to point at a tiny model.

### Storage

Per-thread bindings live in `~/.agim/heartbeat.db` (SQLite). One row per
IM thread; UPSERT keyed on `(platform, channel_id, thread_id)`. Rebinding
the same thread resets `last_tick_at` so the new body takes effect on
the next tick.

## Anthropic native provider (Stage 2 sub-PR #1)

When `provider: 'anthropic'`, agim talks directly to the
[Messages API](https://docs.anthropic.com/en/api/messages) instead of
going through the OpenAI compatibility path. This matters because:

- `system` is a top-level body field (Anthropic doesn't accept a system
  message in the array)
- assistant content is a `[{type:'text'}, {type:'tool_use'}]` block
  array, not a flat string + tool_calls field
- tool results live inside a `user` message as `tool_result` blocks
  rather than a separate `role: 'tool'`
- response `stop_reason` values are different (`end_turn`, `tool_use`,
  `max_tokens`, `stop_sequence`, …)

Agim normalises all of this so callers see the same `LlmMessage`,
`ChatResult`, `ToolCallRequest` types regardless of backend. The
serializer / deserializer logic lives in `anthropic-provider.ts`.

### Recipe

```bash
export AGIM_LLM_SECRET_CLAUDE_BIG=sk-ant-...
```

```jsonc
{
  "llmBackends": [
    {
      "name": "claude-big",
      "provider": "anthropic",
      "model": "claude-3-5-sonnet-20241022",
      "label": "anthropic"
    }
  ],
  "llmRoles": {
    "evaluator": "claude-big"
  }
}
```

### Provider config knobs

| field | default | what |
|---|---|---|
| `baseUrl` | `https://api.anthropic.com` | Override for Bedrock / Vertex / corporate gateway |
| `apiVersion` | `2023-06-01` | `anthropic-version` header — Anthropic pins API behaviour by this date |
| `extraHeaders` | `{}` | Extra headers (e.g. for a gateway). `x-api-key`, `anthropic-version`, `content-type` are always set by the provider |
| `temperature`, `maxTokens`, `retryOnTransient` | (same defaults as openai-compat) | |

### Out of scope (deferred)

- Streaming (the buffered path already works for all Stage-1 + Stage-2
  callers; streaming lands when we wire the "show thinking" feature)
- Prompt caching (`cache_control: {type:'ephemeral'}`) — easy to add
  once we have a place to decide which blocks deserve it
- Extended thinking blocks (`thinking: {type:'enabled'}`)
- Direct Bedrock / Vertex transports (those need different auth flows;
  a separate provider class later)

## Tool calling (Stage 2 sub-PR #1)

Both `openai-compat` and `anthropic` providers now expose tool calling
through a unified type:

```ts
import type { ChatOptions, ToolDef, ToolCallRequest } from 'agim/llm'

const tools: ToolDef[] = [{
  name: 'list_files',
  description: 'List files under a directory',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  },
}]

const result = await provider.chat(messages, { tools, toolChoice: 'auto' })

if (result.finishReason === 'tool_use' && result.toolCalls) {
  for (const call of result.toolCalls) {
    const out = await execute(call.name, call.arguments)
    messages.push({
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls,
    })
    messages.push({
      role: 'tool',
      toolCallId: call.id,
      content: out,
    })
  }
  // call provider.chat(messages, ...) again to continue the loop
}
```

Stage 2 sub-PR #1 only adds the **provider plumbing** for tool calls —
the agent loop that orchestrates the iteration above ships in sub-PR
#3. Stage-1 introspection callers don't pass `tools`, so they're
unaffected.

### Tool-choice support matrix

| value | openai-compat | anthropic |
|---|---|---|
| `'auto'` (default) | `tool_choice: "auto"` | `tool_choice: {type:"auto"}` |
| `'required'` | `tool_choice: "required"` | `tool_choice: {type:"any"}` |
| `'none'` | `tool_choice: "none"` | (omitted; caller should pass `tools: []` instead) |
| `{type:'tool', name}` | `tool_choice: {type:"function", function:{name}}` | `tool_choice: {type:"tool", name}` |

### Malformed JSON arguments

OpenAI emits `function.arguments` as a JSON-encoded string. When the
model produces invalid JSON, agim surfaces it as
`ToolCallRequest.argumentsRaw` and sets `arguments = {}`. Tool
implementations should validate `arguments` themselves or check for
the presence of `argumentsRaw` to handle malformed inputs.

Anthropic doesn't have this issue — `tool_use.input` arrives already
parsed by the API.

## External MCP servers (Stage 2 sub-PR #2)

Agim can attach any number of external MCP (Model Context Protocol)
servers; their tools become available to the native agent loop (sub-PR
#3) alongside the built-in agim tools. The CLI agents (Claude Code /
Codex / OpenCode) keep using their own MCP configs — this layer is
exclusively for the native loop.

### Configuration

```jsonc
{
  "mcpServers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
    },
    {
      "name": "remote-tools",
      "url": "https://mcp.example.com",
      "headers": { "Authorization": "Bearer ${OPS_TOKEN}" }
    }
  ]
}
```

### Transport selection

| field set | transport |
|---|---|
| `command` (+ optional `args`, `env`, `cwd`) | **stdio** — spawn subprocess; MCP framing over stdin/stdout |
| `url` ending in `/sse` | **SSE** (legacy MCP HTTP transport) |
| `url` otherwise | **Streamable HTTP** (modern MCP HTTP transport) |

Exactly one of `command` or `url` must be set per entry; the schema
rejects both/neither at startup with a clear error.

### Per-server knobs

| field | default | what |
|---|---|---|
| `toolTimeoutMs` | `30000` | per-tool-call hard timeout |
| `enabledTools` | `["*"]` | comma-list of tool names (original OR namespaced) to expose. Default = all. |
| `enabled` | `true` | soft kill-switch (keeps the entry, skips connect) |
| `headers` | `{}` | extra HTTP headers (auth tokens, custom routing) — http/sse only |
| `env`, `cwd`, `args` | — | child process knobs — stdio only |

### Tool naming

Discovered tools are prefixed `mcp_{server}_{tool}` to dodge collisions
when two servers both expose the same name (`read_file` is everywhere).
The original name is preserved for error messages + `enabledTools`
filtering (the filter accepts either form).

Example: `@modelcontextprotocol/server-filesystem`'s `read_file` tool
under a server named `filesystem` is exposed as `mcp_filesystem_read_file`.

### Lifecycle

- **Boot**: `loadFromConfig` (synchronous) instantiates clients;
  `connectAll` (async) opens transports in parallel. Per-server failures
  are recorded as `unhealthy` rows; one broken MCP doesn't take down
  agim. Boot log summarises:

  ```text
  🧩 MCP servers: 2 connected (filesystem, github); 14 tools available
     ⚠ remote-tools: HTTP 503 from mcp.example.com
  ```

- **Tool call**: `callMcpToolByName(callName, args)` dispatches to the
  right client. Unknown tool names return `{isError: true, text:'unknown
  MCP tool: ...'}` rather than throwing.

- **Shutdown**: `closeAll` (registered on SIGTERM/SIGINT) terminates
  stdio subprocesses cleanly so agim restarts don't leak orphan
  processes.

### Out of scope (deferred)

- MCP resources (server → client notifications). The agent loop in
  sub-PR #3 doesn't consume them; we can wire them when a use case
  appears.
- MCP prompts exposed as tools (nanobot's pattern). Useful but not
  required.
- Schema normalisation for strict OpenAI `tools[]` (nullable union
  rejection). Will add when a real-world server trips the issue.
- Auto-reconnect on transport drop. The SDK handles some recovery
  internally; if a server goes unhealthy mid-session the agent loop
  surfaces it as a tool error and the user can re-bind via
  `/heartbeat run-now` or by restarting their thread.

### Inspection

`describeMcpRegistry()` returns:

```ts
{
  servers: [
    { name: 'filesystem', connected: true, toolCount: 8 },
    { name: 'remote-tools', connected: false, toolCount: 0, error: 'HTTP 503 ...' },
  ],
  totalTools: 8,
}
```

Currently only consumed by the boot log; a web settings panel showing
the same data lands in Stage 2 sub-PR #4.

## Future stages (preview)

- **Stage 2**: full agent loop, tool dispatch, MCP client, Anthropic native provider. Native chat agent becomes an `AgentAdapter` you can `/cc native` to.
- **Stage 3**: shared Skills engine for CLI and native agents.
- **Stage 4**: `agim config llm` wizard + `/settings/llm-backends` web UI.
- **Stage 5**: `/router compare` A/B evaluator + automatic CLI fallback chain.

Until Stage 4 lands, all `llmBackends` editing is by hand. The schema is stable; no breaking changes between stages.
