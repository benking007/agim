# im-hub-pro

[中文文档](README.zh-CN.md)

**Universal messenger-to-agent bridge** — connect WeChat / Feishu / DingTalk / Telegram / Discord to Claude Code / Codex / Copilot / OpenCode, or any custom agent via ACP. Single Node.js process, no Docker, no Redis.

> Productized fork of the original [`im-hub`](https://www.npmjs.com/package/im-hub). Config dir (`~/.im-hub/`), env vars (`IMHUB_*`), and headers (`X-IM-Hub-Token`) are unchanged — drop-in upgrade. See [Migrating from `im-hub`](#migrating-from-im-hub).

## Highlights

- **5 messengers + email, 4+ agents** — WeChat (image / file / voice), Feishu, DingTalk (image / voice with server-side ASR), Telegram, Discord, Email (SMTP); Claude Code, Codex, Copilot, OpenCode, plus any ACP endpoint
- **`/remind` reminders subsystem** — one-shot + recurring (`每天8点喝水`); LLM auto-detects reminder intent in casual chat; LLM polishes delivery; agent MCP tools; web `/reminders` page; email + IM delivery
- **`/memo` 5W1H persistent memory** — generic "what / who / when / where / how / why" notes with optional GPS capture (browser geolocation H5 + Baidu geocoder); permanent by default, transient bucket for parking spots / today's meeting; agents store + retrieve via MCP tools so casual mentions get remembered automatically
- **Browser dashboard** — chat UI, tasks panel (jobs / schedules / approvals / health / files / audit), reminders panel, settings page with workspace CRUD
- **Human-in-the-loop tool approval** — Claude tool calls pause for `y`/`n` in IM or in-page card; works across all platforms
- **Rich media in WeChat / Telegram / DingTalk** — receive images, files, videos; voice messages transcribed via WeChat STT, DingTalk's server-side ASR, OpenAI Whisper, or whisper.cpp (per-platform fallback chain)
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
im-hub-pro                      # arrow-key wizard (recommended) — picks language,
                                # then per-component setup for every messenger / agent
                                # — or use the legacy per-component commands below:
im-hub-pro config wechat        # QR-code login
im-hub-pro config feishu        # App ID + Secret (no webhook needed)
im-hub-pro config dingtalk      # ClientID + ClientSecret (Stream-mode bot)
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
| **Messengers** | WeChat (iLink — image / file / voice / video), Feishu (WebSocket), DingTalk (Stream mode — image / voice with built-in ASR), Telegram (grammy — photo / voice / audio), Discord (discord.js), Email (SMTP, push-only) |
| **Agents** | Claude Code, Codex, Copilot, OpenCode — all via shared `AgentBase`; any HTTP agent via ACP |
| **Reminders** | `/remind` slash, LLM intent detection, LLM-polished delivery, MCP tools for agents (claude-code + opencode), web `/reminders` UI |
| **Web UI** | Chat with streaming, three-state theme (light / dark / system), bilingual (EN / 中文), SSE dashboard |
| **Tool Approval** | Human-in-the-loop over IM + in-page cards; MCP sidecar for Claude |
| **Jobs** | Persistent SQLite job board + cron scheduler; batch ops; background task reader |
| **Routing** | Intent classifier, circuit breaker, rate limiter, sticky sessions, LLM judge fallback |
| **Workspaces** | Multi-tenant; agent whitelist + rate limits; command-level ACL |
| **Observability** | pino structured logs, traceId, Prometheus `/api/metrics`, SQLite audit log |
| **ACP** | Client (connect to remote agents) + Server (im-hub-pro itself as an ACP agent) |

## CLI Commands

```
im-hub-pro                 # Arrow-key wizard (bilingual zh/en) — recommended entry
im-hub-pro start           # Start the bridge + web UI (foreground)
im-hub-pro start --bg      # Start as a background daemon
im-hub-pro status          # Show service status (systemd / bg / fg)
im-hub-pro restart         # Restart the running service
im-hub-pro stop            # Stop the running service
im-hub-pro uninstall       # Uninstall (keeps ~/.im-hub-workspaces/)
im-hub-pro config wechat   # Configure WeChat
im-hub-pro config feishu   # Configure Feishu
im-hub-pro config dingtalk # Configure DingTalk (Stream-mode internal app)
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
| `/remind …` | Reminders — see [Reminders](#reminders) below |
| `/memo …` | 5W1H persistent memory — see [Memos](#memos) below (aliases `/记`, `/note`) |
| `/job`, `/cron`, `/audit`, `/stats` | Manage jobs, cron schedules, audit, stats (`/schedule` aliases `/cron` until v0.4.0) |
| `/router status\|explain` | Inspect routing decisions |
| `y` / `n` / `批准` / `拒绝` | Approve / deny Claude tool call (or reminder confirmation card) |

## Human-in-the-loop Tool Approval

When a Claude run tries to use a tool, im-hub-pro pauses and sends an approval card:

```
🔐 Tool approval request
Tool: Bash
Input: {"command":"rm -rf node_modules"}
Reply y to approve / n to deny  (auto-deny in 5 min)
```

Reply `y` / `n` in IM, or click Allow / Deny in the web UI. Works identically across WeChat, Telegram, Feishu, DingTalk, and Discord. Disable with `IMHUB_APPROVAL_DISABLED=1`.

## Reminders

Built-in `/remind` subsystem — one-shot or recurring, with three creation paths and three delivery enhancements.

```bash
# One-shot
/remind 2m drink water
/remind 40秒喝水
/remind 下午6点下班
/remind 18:30 出门

# Recurring 🔁
/remind 每5分钟看屏幕外
/remind 每天早上8点喝水
/remind 每周一三五9点站会
/remind 每个工作日18:00下班

# Email delivery ✉️ (requires SMTP — see Configuration)
/remind email me@x.com 8:00 morning briefing
/remind bindemail me@x.com   # bind default → /remind email 每天8点 早安
/remind unbindemail

# Manage
/remind list
/remind cancel <id>
/remind clear
/remind snooze <id> 5m
/remind aiwatch on|off       # toggle the LLM intent detector

# Disable LLM polish for one reminder
/remind literal 每5分钟 喝水
```

**Three creation paths** (all land in the same `~/.im-hub/reminders.db`):

1. **`/remind` slash** — explicit, structured input
2. **LLM intent detection** (default-on) — say "明天早上8点提醒我开会" without `/remind`, the bot pops a confirmation card; reply `y` to create
3. **Agent MCP tools** — claude-code and opencode (stdio) auto-call `create_reminder` when you mention future commitments in chat. Works with opencode (http) too via single-user agent-asserted context

**Two delivery enhancements**:

- **LLM polish** (default-on): at fire time the active agent rewrites the literal seed text into a natural one-liner ("早上好，记得喝杯水"). Tone constrained: *no flattery, no over-humor, no exaggeration*. Falls back to literal text on agent failure / timeout
- **Late-delivery tag**: > 1 h overdue gets `⏰ 延迟投递` prefix so users know the bot was offline

Manage reminders in the web UI at `/reminders` (status filters, snooze, cancel).

Full design: [`docs/architecture/reminders.md`](docs/architecture/reminders.md).

## Memos

`/memo` is a 5W1H persistent memory database. Every memo can carry any subset of `what` / `who` / `when_at` / `where (lat/lng/label)` / `how` / `why` plus an optional `expires_at` lifecycle. Locations are just one axis — the same store also remembers "我爸生日 5月8日" or "苹果发了 AVP2".

```bash
# Slash
/memo                          # search hint + recent memos
/memo list                     # last 10
/memo show <id>
/memo delete <id>
/memo search 茶馆
/memo here [备注]              # one-shot HTTPS link → browser GPS capture
/memo 39.9,116.4 家            # raw coords + label

# Aliases: /记, /note
```

The agent (claude-code / opencode) sees 5 MCP tools and uses them automatically when you mention something worth remembering — no need to invoke a slash:

- `save_memo` — extract 5W1H from natural language and store; `address` arg triggers Baidu geocoder
- `request_location_capture` — return a one-shot H5 link so the user can authorize browser geolocation
- `search_memos` — multi-field AND-combined retrieval ("我的车在哪")
- `update_memo` — patch existing entry (e.g. add `where_*` later, or pass `address` to geocode)
- `delete_memo`

**Lifecycle**: memos default to permanent. Agents only set `expires_in_hours` when content is clearly transient ("我把车停这了" / "今天下午3点开会"). A background sweep deletes expired rows.

**Time zone**: all times are interpreted as Asia/Shanghai (UTC+8) and stored as bare-local `YYYY-MM-DD HH:MM:SS`. Override with `IMHUB_TZ_OFFSET_HOURS` if your deployment is elsewhere.

**Browser GPS capture**: `/memo here` and `request_location_capture` send a one-shot 10-min HTTPS link. Default base URL is `https://agent.iclaw.host`; override with `IMHUB_LOC_BASE_URL=https://your-host` if you want to keep H5 traffic on your own domain.

**Address geocoding (optional)**: set `IMHUB_BAIDU_MAP_AK` to a Baidu Maps AK to enable `address: "中关村大街27号"` style inputs in `save_memo` / `update_memo`. Without it, those calls return "geocoding not configured" but raw coords + browser GPS still work. Get a free AK at [lbsyun.baidu.com](https://lbsyun.baidu.com/) → Console → 应用管理 → 创建应用 → 服务端 API. The default key flow doesn't need SN signing; if you enable SN校验 in the console, see notes in `src/core/locations.ts`.

## Configuration

### Config file
`~/.im-hub/config.json` (validated by zod at startup):

```json
{
  "messengers": ["wechat-ilink", "telegram"],
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

### Email reminders (SMTP)

To enable `/remind email …`, set these environment variables before starting:

```bash
# Required
export IMHUB_SMTP_HOST=smtp.gmail.com
export IMHUB_SMTP_USER=you@gmail.com
export IMHUB_SMTP_PASS=<16-char-app-password>      # NOT your normal password

# Optional
export IMHUB_SMTP_PORT=465                         # default 465
export IMHUB_SMTP_FROM=you@gmail.com               # default = USER
export IMHUB_SMTP_SECURE=auto                      # auto | true | false
```

**Provider quick reference**:

| Provider | HOST | PORT | Notes |
|----------|------|------|-------|
| Gmail | `smtp.gmail.com` | 465 | Use [App Password](https://myaccount.google.com/apppasswords) — 2-Step Verification required |
| QQ Mail | `smtp.qq.com` | 465 | "授权码" (account → POP3/SMTP service) |
| 163 Mail | `smtp.163.com` | 465 | "授权码" (account → POP3/SMTP/IMAP service) |
| Outlook | `smtp-mail.outlook.com` | 587 | Set `IMHUB_SMTP_SECURE=false` (STARTTLS) |
| Custom | any host | any port | Set `SECURE` per provider docs |

Without these env vars, the email adapter still loads but `/remind email …` returns "Email adapter not configured" — IM reminders keep working.

For systemd, put env in your unit file:
```ini
[Service]
Environment="IMHUB_SMTP_HOST=smtp.gmail.com"
Environment="IMHUB_SMTP_USER=you@gmail.com"
Environment="IMHUB_SMTP_PASS=xxxxxxxxxxxxxxxx"
```

### Other env vars

| Env | Default | What it does |
|-----|---------|-------------|
| `IMHUB_WEB_BIND` | `127.0.0.1` | Web UI bind address (set `0.0.0.0` to expose; front with HTTPS reverse proxy) |
| `IMHUB_APPROVAL_DISABLED` | unset | Set `=1` to skip the human-in-the-loop tool approval gate |
| `IMHUB_OPENCODE_DRIVER` | `stdio` | `http` selects the HTTP driver (faster, but reminder MCP path uses single-user agent-asserted context) |
| `IMHUB_OPENCODE_GATE` | `medium` | `strict` / `loose` / `none` — opencode permission gate |
| `IM_HUB_LLM_JUDGE_AGENT` | unset | Agent name used as LLM router fallback judge |
| `OPENAI_API_KEY` | unset | Enables OpenAI Whisper for voice transcription |
| `IMHUB_WHISPERCPP_BIN` + `IMHUB_WHISPERCPP_MODEL` | unset | Local Whisper.cpp for voice transcription (no cloud) |
| `IMHUB_BAIDU_MAP_AK` | unset | Baidu Maps AK; enables `/memo` address-based geocoding. Without it, raw coords + browser GPS still work. |
| `IMHUB_LOC_BASE_URL` | `https://agent.iclaw.host` | Public HTTPS base URL the `/memo here` H5 capture link points at. Override for self-hosted deployments. |
| `IMHUB_TZ_OFFSET_HOURS` | `8` | Hours offset from UTC for memo timestamps (Asia/Shanghai default). Change only if your deployment is elsewhere. |

## Architecture

```
┌─ IM ingress ─────────────────────────────────────┐
│ WeChat iLink   (long-poll + image/voice/file)    │
│ Telegram       (grammy + photo/voice/audio)      │
│ Feishu         (Lark SDK WebSocket)              │
│ DingTalk       (Stream WebSocket + ASR baked in) │
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
| v0.2.37 | Reminders subsystem — `/remind`, LLM intent + polish, agent MCP tools, email channel, web `/reminders`, WeChat context_token persistence |
| v0.3.0 | `/memo` 5W1H persistent memory — `/location` → `/memo` rename, address geocoding via Baidu Maps, opencode HTTP driver SSE drain |
| v0.3.1 | Native location messages on Telegram + Feishu, GCJ-02 → WGS-84 fix across all ingest paths, `memo` column + LLM/heuristic `what` extractor |
| v0.4.0 | codex agent now sees the full imhub MCP toolset (reminder + memo); Telegram + Feishu location messages routed through agent-driven decision making (matches WeChat H5 architecture) |
| v0.5.0–0.5.2 | Bilingual arrow-key `im-hub-pro` wizard; per-component flows (QR for WeChat, credentials prompts for Feishu / Telegram / Discord; live install detection for agents); systemd-unit env fallback for SMTP / Baidu prefill; full service lifecycle commands (`status / start --bg / restart / stop / uninstall`) |
| **v0.6.0** | DingTalk Stream-mode adapter — bidirectional bot bridge via WebSocket, image inbound (`messageFiles/download` → claude-code multimodal Read), voice inbound (server-side ASR `recognition` field, whisper.cpp fallback) |

### v0.7.0 (next)

- [ ] Slack adapter
- [ ] Feishu / DingTalk / Discord button-style approval cards
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
