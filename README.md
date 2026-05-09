# im-hub-pro

[中文文档](README.zh-CN.md)

**Universal messenger-to-agent bridge** — connect WeChat / Feishu / Telegram / Discord to Claude Code / Codex / Copilot / OpenCode, or any custom agent via ACP. Single Node.js process, no Docker, no Redis.

> Productized fork of the original [`im-hub`](https://www.npmjs.com/package/im-hub). Config dir (`~/.im-hub/`), env vars (`IMHUB_*`), and headers (`X-IM-Hub-Token`) are unchanged — drop-in upgrade. See [Migrating from `im-hub`](#migrating-from-im-hub).

## Highlights

- **4 messengers, 4+ agents** — WeChat (image / file / voice), Feishu, Telegram, Discord; Claude Code, Codex, Copilot, OpenCode, plus any ACP endpoint
- **Browser dashboard** — chat UI, tasks panel (jobs / schedules / approvals / health / files / audit), settings page with workspace CRUD
- **Human-in-the-loop tool approval** — Claude tool calls pause for `y`/`n` in IM or in-page card; works across all platforms
- **Rich media in WeChat & Telegram** — receive images, files, videos; voice messages transcribed via WeChat STT, OpenAI Whisper, or whisper.cpp
- **Smart routing** — intent classifier (CJK + ASCII), sticky sessions, circuit breaker, rate limiter
- **Multi-tenant workspaces** — per-workspace agent whitelist, rate limits, command-level ACL
- **Persistent jobs & cron** — SQLite-backed, survives restarts, 30-day retention
- **Observability** — structured logging (pino + traceId), Prometheus metrics, audit log
- **Security** — timing-safe auth, SSRF guards, credential file permissions, approval socket entropy

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

## Quick Start

```bash
npm install -g im-hub-pro    # Requires Node.js ≥ 18 (≥ 22 LTS recommended)

# Configure at least one messenger
im-hub-pro config wechat        # QR-code login
im-hub-pro config feishu        # App ID + Secret (no webhook needed)
im-hub-pro config telegram      # @BotFather token
im-hub-pro config discord       # Bot token; see docs/discord-setup.md

# (Optional) Connect a custom remote agent over ACP
im-hub-pro config agent

# Start the bridge
im-hub-pro start
```

Web UI at `http://localhost:3000` — chat at `/`, tasks at `/tasks`, settings at `/settings`.

### Migrating from `im-hub`

```bash
npm uninstall -g im-hub
npm install -g im-hub-pro
im-hub-pro start          # config, env vars, headers all unchanged
```

## Features

| Category | Details |
|----------|---------|
| **Messengers** | WeChat (iLink — image / file / voice / video), Feishu (WebSocket), Telegram (grammy — photo / voice / audio), Discord (discord.js) |
| **Agents** | Claude Code, Codex, Copilot, OpenCode — all via shared `AgentBase`; any HTTP agent via ACP |
| **Web UI** | Chat with streaming, three-state theme (light / dark / system), bilingual (EN / 中文), SSE dashboard |
| **Tool Approval** | Human-in-the-loop over IM + in-page cards; MCP sidecar for Claude |
| **Jobs** | Persistent SQLite job board + cron scheduler; batch ops; background task reader |
| **Routing** | Intent classifier, circuit breaker, rate limiter, sticky sessions, LLM judge fallback |
| **Workspaces** | Multi-tenant; agent whitelist + rate limits; command-level ACL |
| **Observability** | pino structured logs, traceId, Prometheus `/api/metrics`, SQLite audit log |
| **ACP** | Client (connect to remote agents) + Server (im-hub-pro itself as an ACP agent) |

## CLI Commands

```
im-hub-pro start           # Start the bridge + web UI
im-hub-pro config wechat   # Configure WeChat
im-hub-pro config feishu   # Configure Feishu
im-hub-pro config telegram # Configure Telegram
im-hub-pro config discord  # Configure Discord
im-hub-pro config claude   # Configure Claude Code
im-hub-pro config agent    # Connect a custom ACP agent
im-hub-pro agents          # List available agents
im-hub-pro messengers      # List available messengers
```

## Chat Commands

| Command | What it does |
|---------|-------------|
| any text | Route to agent (sticky session, intent-classified) |
| `/<agent> <prompt>` | Switch agent — `/cc`, `/oc`, `/cx`, `/co` |
| `/new` | New conversation (clear context) |
| `/model [provider/model]` | View or switch model |
| `/think on\|off` | Toggle extended thinking |
| `/job`, `/schedule`, `/audit`, `/stats` | Manage jobs, schedules, audit, stats |
| `/router status\|explain` | Inspect routing decisions |
| `y` / `n` / `批准` / `拒绝` | Approve / deny Claude tool call |

## Human-in-the-loop Tool Approval

When a Claude run tries to use a tool, im-hub-pro pauses and sends an approval card:

```
🔐 Tool approval request
Tool: Bash
Input: {"command":"rm -rf node_modules"}
Reply y to approve / n to deny  (auto-deny in 5 min)
```

Reply `y` / `n` in IM, or click Allow / Deny in the web UI. Works identically across WeChat, Telegram, Feishu, and Discord. Disable with `IMHUB_APPROVAL_DISABLED=1`.

## Architecture

```
┌─ IM ingress ─────────────────────────────────────┐
│ WeChat iLink   (long-poll + image/voice/file)    │
│ Telegram       (grammy + photo/voice/audio)      │
│ Feishu         (Lark SDK WebSocket)              │
│ Discord        (discord.js Gateway)              │
│ Web Chat       (browser WebSocket)               │
└───────────────────────┬──────────────────────────┘
                        │ MessageContext
                        ▼
          ┌── Pre-route gates ────────────────┐
          │ workspace · rate limiter · traceId │
          └────────────────┬──────────────────┘
                           ▼
          ┌── Intent router ──────────────────┐
          │ command → builtin                  │
          │ /agent  → explicit switch          │
          │ default → classify (regex/keyword/ │
          │           sticky/LLM judge)        │
          └────────────────┬──────────────────┘
                           ▼
          ┌── Agent invocation ───────────────┐
          │ circuit breaker + spawn stream     │
          └───┬──────┬──────┬──────┬──────┬───┘
              ▼      ▼      ▼      ▼      ▼
          claude  opencode codex copilot  ACP
              │
              ▼ (tool approval)
        MCP sidecar → approvalBus → IM thread

┌─ Cross-cutting ──────────────────────────────────┐
│ SQLite (audit · jobs · schedules)                │
│ session (append-only JSONL)                      │
│ Prometheus metrics · pino structured logging     │
└──────────────────────────────────────────────────┘
```

Single process, zero external dependencies — SQLite + session files are the entire persistence layer.

For the full deep-dive see [`docs/architecture/current.md`](docs/architecture/current.md).

## Configuration

Config file: `~/.im-hub/config.json` (validated by zod at startup)

```json
{
  "messengers": ["wechat", "telegram"],
  "agents": ["claude-code", "opencode"],
  "defaultAgent": "claude-code",
  "telegram": { "botToken": "***" },
  "acpAgents": [
    {
      "name": "my-agent",
      "endpoint": "https://api.example.com",
      "auth": { "type": "bearer", "token": "***" }
    }
  ],
  "workspaces": [
    {
      "id": "team-data",
      "name": "Data team",
      "agents": ["opencode", "my-agent"],
      "members": ["user-123"],
      "rateLimit": { "rate": 30, "intervalSec": 60, "burst": 60 }
    }
  ]
}
```

## Requirements

- **Node.js ≥ 18** (≥ 22 LTS recommended)
- At least one agent CLI or ACP endpoint:
  - `npm i -g @anthropic-ai/claude-code`
  - `npm i -g @openai/codex`
  - `npm i -g @github/copilot`
  - `npm i -g opencode-ai`

## Development

```bash
git clone https://github.com/benking007/imhub.git && cd imhub
npm install
npm run build      # tsc + copy public/
npm run dev        # tsc --watch
npm test           # bun test
npm run lint       # biome lint
npm run typecheck  # tsc --noEmit
```

## Deployment

See [`docs/deployment.md`](docs/deployment.md) for systemd, Docker, nginx, monitoring, and upgrade instructions.

## Roadmap

### Done

| Version | Theme |
|---------|-------|
| v0.1.x | MVP — WeChat + 4 agents + command routing |
| v0.2.0 | Multi-IM — Feishu, Telegram, sessions, ACP |
| v0.2.13 | Foundations — logging, audit, intent, jobs, metrics, workspaces |
| v0.2.14 | Human-in-the-loop tool approval |
| v0.2.15 | Discord adapter + tasks dashboard |
| v0.2.16–17 | Security hardening + observability |
| v0.2.18–19 | IM reconnect backoff, Codex sandbox, dashboard filters |
| v0.2.20–23 | Web console — theme, approvals, SSE, files, batch ops |
| v0.2.30 | Production hardening — session isolation, serial WS, loopback bind |
| v0.2.35 | WeChat & Telegram rich media — image / file / voice / video |

### v0.3.0 (next)

- [ ] DingTalk adapter
- [ ] Slack adapter
- [ ] Feishu / Discord button-style approval cards
- [ ] Multi-instance event bus (Redis Streams / NATS)
- [ ] Workspace member picker UI

## Community

<p align="center">
  <a href="https://discord.gg/R83CXYz5">
    <img src="https://img.shields.io/badge/Join_Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord">
  </a>
  &nbsp;
  <a href="https://x.com/lijieisme">
    <img src="https://img.shields.io/badge/Follow_on_X-000000?style=for-the-badge&logo=x&logoColor=white" alt="X">
  </a>
</p>

## License

MIT
