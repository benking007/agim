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
| `provider` | yes | Stage 1: only `openai-compat`. |
| `model` | yes | The default model id sent in every request. |
| `baseUrl` | no | Defaults to `https://api.openai.com/v1`. Strip the trailing `/chat/completions`; the provider appends it. |
| `label` | no | Display label for logs / future cost dashboard (e.g. `deepseek` / `kimi`). Defaults to `openai-compat`. |
| `extraHeaders` | no | Merged into every request. Useful for OpenRouter (`HTTP-Referer`, `X-Title`), Azure (`api-key`). `Authorization` is NOT overridable here — it's set automatically from the secret. |
| `temperature` | no | Default 0.3 (deterministic JSON). |
| `maxTokens` | no | Default 1024. |
| `retryOnTransient` | no | Number of retries on 408/429/5xx. Default 1. |
| `enabled` | no | Soft kill-switch. Default true. |

### 2. `llmRoles` map

Roles are operational concepts agim's internal callers ask for. Stage 1 only consumes:

- `cheap` — distill / consolidate / intent-llm

Other role keys (`evaluator`, `native-chat`, `native-coder`) are reserved for later stages and accepted by the schema for forward compatibility.

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

## Future stages (preview)

- **Stage 2**: full agent loop, tool dispatch, MCP client, Anthropic native provider. Native chat agent becomes an `AgentAdapter` you can `/cc native` to.
- **Stage 3**: shared Skills engine for CLI and native agents.
- **Stage 4**: `agim config llm` wizard + `/settings/llm-backends` web UI.
- **Stage 5**: `/router compare` A/B evaluator + automatic CLI fallback chain.

Until Stage 4 lands, all `llmBackends` editing is by hand. The schema is stable; no breaking changes between stages.
