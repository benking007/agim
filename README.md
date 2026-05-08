# im-hub-pro

[中文文档](README.zh-CN.md)

**Universal messenger-to-agent bridge** — connect WeChat / Feishu / Telegram / **Discord** to Claude Code / Codex / Copilot / OpenCode, **or any custom agent via ACP**. Single Node.js process, no Docker, no Redis. Browser dashboard, persistent jobs, multi-tenant workspaces, and real human-in-the-loop tool approval over IM.

> Productized fork of the original [`im-hub`](https://www.npmjs.com/package/im-hub). On-disk config (`~/.im-hub/`), env vars (`IMHUB_*`), and HTTP headers (`X-IM-Hub-Token`) are unchanged — drop-in compatible. See [Migrating from `im-hub`](#migrating-from-im-hub) below.

## What's new in v0.2.13 → v0.2.30

- **Discord adapter** (Gateway WebSocket via `discord.js`)
- **Human-in-the-loop tool approval** — Claude pauses on tool calls; you reply `y`/`n` in the same IM thread, **or click an in-page card from the web chat**
- **Tasks dashboard** at `/tasks` with **Jobs · Background · Subtasks · Schedules · Approvals · Health · Files · Audit** tabs (per-agent filtering, multi-select batch ops, real-time SSE updates)
- **Multi-tenant workspaces** — per-workspace agent whitelist + rate limits, **with full CRUD UI in /settings**, plus command-level ACL on `/job` `/schedule` `/audit` (each user only sees their own)
- **ACP server mode** — im-hub-pro itself is an ACP-compatible agent (`POST /tasks` sync + SSE)
- **Persistent Job Board** + cron scheduler (SQLite, survives restarts) with 30-day retention sweep
- **Smart routing**: intent classifier (CJK + ASCII), circuit breaker, sticky sessions
- **Structured logging** (`pino`) with `traceId` end-to-end + audit log + Prometheus `/api/metrics`
- **Three-state theme** (light / dark / system) on every page — applied before first paint to avoid flash
- **v0.2.16 — Security hardening (P0 + P1)**: timing-safe token compare, Schedule `notify_url` SSRF guard, secret redaction in logs, approval-socket entropy + perms, `Session.addMessage` per-key mutex
- **v0.2.17 — Observability & IM polish (P2 + P3)**: static-page CSP / `X-Frame-Options` / `X-Content-Type-Options`, WebSocket connection cap + backpressure, Prometheus label-cardinality whitelist, new counters (`im_hub_audit_prune_failed_total` / `im_hub_agent_cleanup_failed_total` / `im_hub_approval_*`), UTF-16 surrogate-safe message split, auto-allow fingerprint 5→10 chars, SQLite WAL clean checkpoint on SIGINT
- **v0.2.18 — IM reconnect backoff (M9)**: shared `Backoff` helper (exponential + ±50% jitter) replaces fixed 2s / 5s reconnect delays in Telegram + WeChat polling; defeats thundering-herd on shared network recovery
- **v0.2.19 — Codex sandbox-mode plan + Dashboard filter / Audit tab**: codex now honors `session.planMode` (default sandbox switched to explicit `-s workspace-write`); jobs / subtasks / schedules tabs gain per-agent filter; new Audit tab pulls the SQLite audit log into the dashboard
- **v0.2.20 — Web console PR-A**: three-state theme manager + global error boundary + in-page approval cards (click Allow / Deny / Allow + Auto from the chat UI itself)
- **v0.2.21 — Web console PR-B**: Health tab (per-agent breaker / rate-limiter / latency p50/95/99 / sparkline) + Approvals tab (browse and resolve every pending HITL approval from the dashboard)
- **v0.2.22 — Web console PR-C**: SSE event stream (`/events`) replaces polling for audit / approval / job / metrics events; full Workspace CRUD UI in /settings
- **v0.2.23 — Web console PR-D**: Files tab — read-only browser of `~/.im-hub-workspaces/<agent>/`; Jobs tab gains multi-select + batch cancel / run; settings page header / container restyled
- **v0.2.30 — Production hardening**: active subtask turns now use isolated sub-sessions and native agent sessions; WebSocket chat ingress is serialized per browser connection; session metadata writes use per-key locking; Web UI defaults to loopback binding; config files are written `0600`; Telegram media downloads reject redirects; `im-hub-pro --version` reads the package version

See [CHANGELOG.md](CHANGELOG.md) and [docs/code-review-2026-05-06-main.md](docs/code-review-2026-05-06-main.md) for the full list.

## Web Chat & Tasks Dashboard

```
im-hub-pro start       # Web UI at http://localhost:3000
                       #   /          chat (with in-page approval cards)
                       #   /tasks     jobs · background · subtasks · schedules
                       #              · approvals · health · files · audit
                       #   /settings  agents · messengers · ACP · workspaces
```

- Real-time streaming via WebSocket; **dashboard pushed via SSE `/events`** (audit / approval / job / metrics)
- Agent switching and chat history
- **Three-state theme** (light / dark / system) with per-tab persistence + global error boundary
- Bilingual UI (English / 中文) — auto-detects browser language
- `/tasks` surfaces persistent jobs, cron schedules, **`~/.claude/bgjobs`** + **`~/.config/opencode/bgjobs`** + **`~/.codex/bgjobs`** background tasks (override via `IMHUB_BGJOB_ROOTS`), every subtask in every session, agent health (breaker · rate-limiter · p50/95/99 · sparkline), pending HITL approvals (resolve from the browser), and a read-only file browser into `~/.im-hub-workspaces/<agent>/`

## Features

- **Universal multiplexer** — one instance, multiple messengers, multiple agents
- **Custom agent support** — connect any agent via [ACP](https://agentcommunicationprotocol.dev) with `im-hub-pro config agent`, or auto-discover via `/.well-known/acp`
- **Built-in IMs** — WeChat (iLink), Feishu (WebSocket long-poll), Telegram (grammy), **Discord** (discord.js)
- **Built-in CLI agents** — Claude Code, Codex, Copilot, OpenCode (all via shared `AgentBase` adapter)
- **Plugin architecture** — easy to add new messengers / agents
- **TypeScript native** — no Go, no Docker, no Redis
- **JSONL streaming** — real-time agent responses with multi-byte UTF-8 safety

## Installation

```bash
npm install -g im-hub-pro
```

Requires **Node.js ≥ 18** (production deployments use ≥ 22 LTS — see [`docs/deployment.md`](docs/deployment.md)).

### Migrating from `im-hub`

Your `~/.im-hub/` config dir, `IMHUB_*` env vars, `X-IM-Hub-Token` header, and ACP wire identifiers (`im-hub-gateway`) are unchanged — this is a brand rename only.

```bash
npm uninstall -g im-hub
npm install -g im-hub-pro
im-hub-pro start
```

## Quick Start

```bash
# 1. Configure at least one messenger
im-hub-pro config wechat        # QR-code login
im-hub-pro config feishu        # App ID + Secret (no webhook needed)
im-hub-pro config telegram      # @BotFather token
im-hub-pro config discord       # Bot token; see docs/discord-setup.md

# 2. (Optional) Configure a CLI agent — most are auto-detected
im-hub-pro config claude

# 3. (Optional) Connect a custom remote agent over ACP
im-hub-pro config agent

# 4. Start the bridge
im-hub-pro start
```

### Feishu (WebSocket Long Polling)

- ✅ No webhook configuration needed
- ✅ No public IP or domain required
- ✅ No ngrok or similar tools needed
- ✅ Works directly from localhost

### Discord

See [`docs/discord-setup.md`](docs/discord-setup.md) for the full bot-token / intents / OAuth flow.

### Connect Your Own Agent

im-hub-pro speaks **ACP (Agent Communication Protocol)**, so you can plug in any agent that exposes a standard HTTP endpoint — your own business bots, internal tools, cloud services, anything.

```bash
im-hub-pro config agent
# Interactive setup: name, endpoint URL, auth (none / Bearer / API key)
# Connection is validated automatically; /.well-known/acp is auto-discovered
```

After setup, chat with it the same way as built-in agents:

```
/myagent analyze the Q1 sales report
```

### Use im-hub-pro *as* an agent

im-hub-pro also exposes an ACP server — point any ACP-compliant client at `POST http://localhost:3000/tasks` (sync) or with `?mode=stream` (SSE). Auth is the same `Authorization: Bearer <web-token>`.

## CLI Commands

```
im-hub-pro                 # Same as 'start'
im-hub-pro start           # Start the bridge + web UI
im-hub-pro config wechat   # Configure WeChat
im-hub-pro config feishu   # Configure Feishu
im-hub-pro config telegram # Configure Telegram
im-hub-pro config discord  # Configure Discord
im-hub-pro config claude   # Configure Claude Code
im-hub-pro config agent    # Connect a custom ACP agent
im-hub-pro agents          # List available agents
im-hub-pro messengers      # List available messengers
im-hub-pro help
```

## Chat Commands

Send these as messages to the bot. Responses are streamed back in the same thread.

| Command | What it does |
|---|---|
| (any text) | Route to the agent (sticky session, intent-classified) |
| `/<agent> <prompt>` | Switch agent and send (e.g. `/cc explain this`, `/oc`, `/cx`, `/co`) |
| `/help` | Show available commands |
| `/agents` | List available agents |
| `/status` | Show connection status |
| `/new` | Start a new conversation (clear context) |
| `/router status\|policy\|explain\|reset` | Inspect routing decisions, predict where a message would go |
| `/audit [n]` | Recent invocations from the audit log |
| `/job ...` | Inspect / cancel persistent jobs |
| `/schedule ...` | List / add / remove cron schedules |
| `/sessions` | List recent sessions for this thread |
| `/model [provider/model]` | View or change the session's model |
| `/models` | List models the current agent supports |
| `/think on\|off\|...` | Toggle "think harder" / extended-thinking modes |
| `/stats` | Per-agent invocation / latency / error stats |
| `y` / `n` / `批准` / `拒绝` | Approve or deny a pending Claude tool call (HITL) |

## Human-in-the-loop Tool Approval

When a Claude run launched from IM tries to use a tool, im-hub-pro pauses it and posts an approval card to the same IM thread:

```
🔐 Tool approval request
Tool: Bash
Input: {"command":"rm -rf node_modules"}
Reply y to approve / n to deny  (auto-deny in 5 min)
req: a3f1c0d2
```

Reply `y`, `n`, `批准`, `拒绝`, etc. — the decision flows back through an MCP sidecar to Claude, which resumes (or aborts) accordingly. The same chain works for WeChat, Telegram, Feishu, and Discord with no per-platform changes. Disable with `IMHUB_APPROVAL_DISABLED=1`.

## Architecture

```
                       ┌─── External triggers ───┐
                       │ cron 30s tick            │
                       │ webhook → /api/notify    │
                       │ REST   → /api/invoke     │
                       │ ACP    → /tasks (sync/SSE)│
                       └────────────┬─────────────┘
┌─ IM ingress ──────────────────────┼───────────────────┐
│ WeChat iLink   (long-poll + heartbeat)               │
│ Telegram       (grammy)                              │
│ Feishu         (Lark SDK WebSocket)                  │
│ Discord        (discord.js Gateway)                  │
│ Web Chat       (browser WebSocket)                   │
└────────────────────────────────┬──────────────────────┘
                                 │ MessageContext
                                 ▼
            ┌── Pre-route gates ────────────────┐
            │ workspace.resolve(userId)          │
            │ rateLimiter.allow(userKey)         │
            │ traceId + pino child logger        │
            └────────────────┬───────────────────┘
                             ▼
            ┌── parseMessage + Intent ──────────┐
            │ /<cmd>     → builtin sub-command  │
            │ /<agent>   → explicit switch      │
            │ default    → classifyIntent       │
            │   ├ topic regex (CJK + ASCII)     │
            │   ├ keyword profile               │
            │   ├ sticky session bias           │
            │   └ LLM judge (opt-in fallback)   │
            └────────────────┬───────────────────┘
                             ▼
            ┌── Agent invocation ───────────────┐
            │ workspace whitelist + circuit     │
            │ breaker + isAvailable cache       │
            │ AgentBase.sendPrompt → spawnStream │
            │  (LineBuffer · true streaming ·   │
            │   abort/timeout · UTF-8 safe)     │
            └────────────────┬───────────────────┘
              ┌──────┬───────┼────────┬─────────┐
              ▼      ▼       ▼        ▼         ▼
          opencode claude  codex   copilot   ACP remote
                     │
                     ▼ (if a tool needs approval)
              MCP sidecar ─ unix socket ─ approvalBus
                                            └─ approvalRouter → IM thread

┌─ Cross-cutting ───────────────────────────────────────┐
│ audit-log    (SQLite, 30-day retention)               │
│ job-board    (SQLite, persistent + AbortController)   │
│ scheduler    (30s tick → cron → enqueue jobs)         │
│ workspaces   (per-tenant agent whitelist + limits)    │
│ metrics      (Prometheus text via /api/metrics)       │
│ session      (~/.im-hub/sessions/, append-only JSONL) │
│ pino         (traceId end-to-end, JSON in production) │
└───────────────────────────────────────────────────────┘
```

Single-process, single-instance: SQLite (`audit.db` / `jobs.db` / `schedules.db`) plus a session file tree is the entire persistence layer. No Redis, no MQ.

For the full deep-dive see [`docs/architecture/current.md`](docs/architecture/current.md).

## Project Structure

```
im-hub-pro/
├── src/
│   ├── core/
│   │   ├── types.ts              # Plugin interfaces
│   │   ├── registry.ts           # Plugin registration
│   │   ├── router.ts             # Message routing
│   │   ├── session.ts            # Session manager (append-only JSONL)
│   │   ├── workspace.ts          # Multi-tenant workspaces
│   │   ├── intent.ts             # Intent classifier
│   │   ├── intent-llm.ts         # LLM judge fallback (LRU cached)
│   │   ├── circuit-breaker.ts    # Per-agent breaker
│   │   ├── rate-limiter.ts       # Token-bucket
│   │   ├── job-board.ts          # Persistent jobs + cancel
│   │   ├── schedule.ts           # Cron tick → job enqueue
│   │   ├── audit-log.ts          # SQLite audit
│   │   ├── metrics.ts            # Prometheus quantiles
│   │   ├── acp-server.ts         # /tasks ACP server
│   │   ├── approval-bus.ts       # Tool-approval pub/sub
│   │   ├── approval-router.ts    # Approval ↔ IM bridge
│   │   ├── bgjob-reader.ts       # ~/.claude + ~/.config/opencode bgjobs
│   │   ├── agent-base.ts         # Shared spawn-stream for CLI agents
│   │   ├── config-schema.ts      # Zod schema
│   │   ├── logger.ts             # pino + traceId
│   │   ├── sqlite-helper.ts      # Shared prepare/PRAGMA cache
│   │   └── commands/             # /audit /router /job /schedule /model …
│   ├── plugins/
│   │   ├── messengers/
│   │   │   ├── wechat/           # iLink long-poll
│   │   │   ├── feishu/           # Lark SDK WebSocket
│   │   │   ├── telegram/         # grammy
│   │   │   └── discord/          # discord.js
│   │   └── agents/
│   │       ├── claude-code/      # + MCP approval sidecar
│   │       ├── codex/
│   │       ├── copilot/
│   │       ├── opencode/
│   │       └── acp/              # ACP client + /.well-known discovery
│   ├── index.ts
│   ├── cli.ts
│   └── web/
│       ├── server.ts             # HTTP + WS + REST + ACP server
│       └── public/
│           ├── index.html         # Chat UI
│           ├── tasks.html         # Tasks dashboard
│           └── settings.html      # Settings UI
├── docs/
│   ├── architecture/{current,target}.md
│   ├── adr/{0001,0002,0003}-*.md
│   ├── deployment.md
│   ├── discord-setup.md
│   └── upgrade-plan.md
├── package.json
├── tsconfig.json
└── README.md
```

## Configuration

Config file: `~/.im-hub/config.json`

```json
{
  "messengers": ["wechat", "discord"],
  "agents": ["claude-code", "opencode"],
  "defaultAgent": "claude-code",
  "discord": {
    "botToken": "***",
    "allowedGuilds": [],
    "allowedChannels": []
  },
  "acpAgents": [
    {
      "name": "my-agent",
      "aliases": ["ma"],
      "endpoint": "https://api.example.com",
      "auth": { "type": "bearer", "token": "***" },
      "enabled": true
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

The schema is enforced by `zod` at startup and on every PUT `/api/config` — bad configs reject loudly instead of silently breaking the bridge.

## Requirements

- **Node.js 18+** (≥ 22 LTS recommended for production)
- **At least one Agent CLI** (or an ACP remote endpoint):
  - `npm i -g @anthropic-ai/claude-code`
  - `npm i -g @openai/codex`
  - `npm i -g @github/copilot`
  - `npm i -g opencode-ai`

## Development

```bash
git clone https://github.com/benking007/imhub.git
cd imhub
npm install
npm run build      # tsc + copy public/
npm run dev        # tsc --watch
npm test           # bun test
npm run typecheck  # tsc --noEmit (src + tests)
npm start
```

## Roadmap

### v0.1.x (MVP)
- [x] WeChat adapter with QR login
- [x] Claude Code, Codex, Copilot, OpenCode agents
- [x] Basic command routing

### v0.2.0 — Multi-IM
- [x] Feishu adapter
- [x] Telegram adapter
- [x] Session persistence with conversation history
- [x] ACP custom agent support

### v0.2.x — Web & UI
- [x] Web Chat UI with streaming
- [x] Settings page
- [x] Bilingual UI (EN / 中文)

### v0.2.13 — Foundations
- [x] Structured logging (pino) + traceId
- [x] Zod config schema validation
- [x] AgentBase abstraction + healthCheck cache
- [x] Audit log (SQLite) + `/audit`
- [x] Intent classifier + circuit breaker + rate limiter
- [x] ACP server mode (`POST /tasks` sync + SSE)
- [x] `/.well-known/acp` discovery
- [x] Multi-tenant workspaces + agent whitelist
- [x] Persistent Job Board + cron scheduler
- [x] Web `/tasks` panel + REST jobs API
- [x] Prometheus metrics

### v0.2.14 — Tool approval
- [x] Human-in-the-loop tool approval over IM
- [x] MCP approval sidecar (claude-code adapter)

### v0.2.15 — Discord & Dashboard
- [x] Discord messenger adapter
- [x] Tasks dashboard surfaces Claude / opencode bgjobs
- [x] Flattened subtasks tab

### v0.2.16 — Security hardening (P0 + P1)
- [x] Timing-safe REST + WS token compare (shared `safe-equal`)
- [x] Schedule `notify_url` SSRF gate (http(s) only, RFC1918 / loopback / IPv6 ULA blocked) + 10s fetch timeout + redirect:'manual'
- [x] HTML token injection: `JSON.stringify` instead of single-quote splice
- [x] Telegram bot-token redaction in logs (pino `redact.paths` + adapter-level scrub)
- [x] WeChat credential file `0o600` + parent dir `0o700`
- [x] Approval socket path uses 128-bit random + post-listen `chmod 0o600` + stat verification
- [x] Job result size cap (`IMHUB_JOB_RESULT_MAX_BYTES`, default 1 MiB) + UTF-8/JSON safe truncation
- [x] Job-board retention + 6h sweep + `creator_id` / `workspace_id` schema migration
- [x] Multi-tenant ACL on `/job` `/schedule` `/audit` commands (each user sees only their own rows; legacy ownerless rows stay visible for safe upgrades)
- [x] Workspace whitelist enforced on direct command paths, not just routing
- [x] Rate-limiter opportunistic auto-cleanup (no setInterval timer)
- [x] `Session.addMessage` per-key mutex (defeats concurrent read-modify-write race)

### v0.2.17 — Observability & IM polish (P2 + P3)
- [x] Static-page security headers (`X-Frame-Options` / `X-Content-Type-Options` / `Referrer-Policy` / CSP)
- [x] `/api/health` declared public (k8s liveness friendly)
- [x] WebSocket connection cap (`IMHUB_MAX_WS_CLIENTS`, default 100) + `bufferedAmount` backpressure (4 MiB highwater)
- [x] Prometheus label-cardinality whitelist (`intent` / `platform` → `'other'` for unknowns)
- [x] New counters: `im_hub_audit_prune_failed_total`, `im_hub_agent_cleanup_failed_total`, `im_hub_approval_pending` / `im_hub_approval_requests_total` / `im_hub_approval_resolved_total{result=allow|deny|timeout}`
- [x] `intent-llm` cache key SHA-256 + 256-char prompt cap (defeats LRU memory bloat)
- [x] Auto-allow fingerprint 5 → 10 chars (`git status` ≠ `git stash` ≠ `git submo`)
- [x] UTF-16 surrogate-safe message split (emoji at boundary no longer renders as `□`)
- [x] Telegram HTML escape covers `'` / `"` (approval-card `<a href="...">` safety)
- [x] approval-bus over-cap deny instead of silent socket destroy
- [x] SQLite WAL clean checkpoint on SIGINT
- [x] traceId 12 hex → 16 hex (`~2^48` → `~2^64`)
- [x] WeChat ilink-client fetch timeouts on remaining 4 callsites
- [x] Discord typing interval companion `AbortController` (no race with `client.destroy()`)
- [x] WeChat `contextTokens` periodic cleanup on heartbeat tick
- [x] CI lockfile fix (Tencent mirror URLs → `https://registry.npmjs.org/`)

### v0.2.18 — IM reconnect backoff (M9)
- [x] Shared `Backoff` helper (exponential + ±jitter, RNG-injectable for tests)
- [x] Telegram `runPollingLoop`: fixed 2s / 5s setTimeouts → `Backoff(2s, 60s, 0.5)`; 30s healthy-run threshold resets backoff
- [x] WeChat ilink `pollLoop`: inline `Math.pow(2,n-1)` → `Backoff(2s, 30s, 0.5)`; success path resets

### v0.2.19 — Codex sandbox + Dashboard filter / Audit tab
- [x] Codex now honors `session.planMode`; default sandbox `--full-auto` → explicit `-s workspace-write`
- [x] Per-agent filter on Jobs / Subtasks / Schedules tabs (`OwnerOpts.agent` plumbed through)
- [x] New Audit tab in `/tasks` pulling SQLite audit log + `GET /api/audit?agent=&days=&user=&intent=`

### v0.2.20 — Web console PR-A: theme + error boundary + in-page approval
- [x] Three-state theme (light / dark / system) applied synchronously in `<head>` to defeat flash
- [x] `_app.js` shared utility: `window.imhub.{theme,i18n,api,showError}` + auto-installed error boundary
- [x] In-chat approval cards on `/` (Allow / Deny / Allow + Auto), routed through the same `approvalBus.resolvePending()` path as Telegram
- [x] `approval-router` `bindButtonHandlerForPlatform(platform)` exported so late-registered messengers (web is one) can wire their button handler

### v0.2.21 — Web console PR-B: Health + Approvals tabs
- [x] Health tab: per-agent breaker phase (closed/open/half-open) + rate-limiter remaining + p50/95/99 latency + invocations / success rate / cost / cooldown + 60-poll p95 sparkline
- [x] Approvals tab: list every pending HITL approval (reqId / threadId / tool / age / registeredAt) with browser-side Allow / Deny / Allow + Auto buttons
- [x] Backend: `GET /api/agent-health` / `GET /api/approvals` / `POST /api/approvals/:reqId/resolve`
- [x] `approval-bus.PendingApproval` now carries `input` + `registeredAt`; emits `'approval'` events for SSE

### v0.2.22 — Web console PR-C: SSE event stream + Workspace CRUD UI
- [x] `src/core/event-bus.ts` — typed publish/subscribe (audit / approval / job / metrics) with 200-entry replay ring buffer
- [x] `GET /events` SSE endpoint — token via `?token=`, 25s heartbeat, listener-error swallow
- [x] Dashboard `EventSource('/events?token=...')` refreshes only the visible tab; polling kept as fallback; `approval requested` flashes the tab badge
- [x] Settings page Workspace card — list + create / edit / delete (id locked on edit; default row uneditable + undeletable)
- [x] Backend `GET/POST/PATCH/DELETE /api/workspaces` + `WorkspaceRegistry.{remove(id), listFull()}`; mutations persisted back to `~/.im-hub/config.json`

### v0.2.23 — Web console PR-D: Files tab + Jobs batch ops + settings polish
- [x] Files tab — read-only browse of `~/.im-hub-workspaces/<agent>/`, two-pane (dir tree + content), 1 MiB cap, NUL-byte binary detect → base64
- [x] Path-traversal defense: agent name whitelisted against `registry.listAgents()`; resolved path must equal or live below `defaultAgentCwd(agent)`
- [x] Jobs tab multi-select + select-all + hidden-until-needed batch toolbar; selection state survives refresh
- [x] `POST /api/jobs/batch-cancel` / `batch-run` accept `{ ids: number[] }` (max 100); per-id failures don't fail the whole request
- [x] Settings header restyle (`.brand` + `.controls` flex groups) — fixes language `<select>` stretching across the bar; container 720→880, sticky header, theme-aware toast / `.btn-danger:hover`

### v0.3.0
- [ ] DingTalk adapter
- [ ] Slack adapter
- [ ] Approval cards (Feishu/Discord buttons) instead of plain text
- [ ] Cron `nextOccurrence` internal UTC normalization (DST safety, M5 from CR-2026-05-06)
- [ ] Multi-instance event bus (Redis Streams / NATS) so SSE works across replicas
- [ ] Workspace member picker UI (current CSV input is ops-friendly but error-prone)

## Community <a name="wechat-group"></a>

Questions? Feel free to reach out on [X](https://x.com/lijieisme) or join the Discord.

<p align="center">
  <a href="https://discord.gg/R83CXYz5">
    <img src="https://img.shields.io/badge/Join_Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord">
  </a>
  &nbsp;
  <a href="https://x.com/lijieisme">
    <img src="https://img.shields.io/badge/Follow_on_X-000000?style=for-the-badge&logo=x&logoColor=white" alt="X">
  </a>
</p>

<p align="center">
  <img src="assets/wechat-group" alt="Original author WeChat" width="180"><br>
  <sub><i>Original author's contact</i></sub>
</p>

## License

MIT
