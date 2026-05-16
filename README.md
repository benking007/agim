# Agim · 阿吉姆

[中文文档](README.zh-CN.md)

**Universal messenger-to-agent bridge** — connect WeChat / Feishu / DingTalk / Telegram / Discord to Claude Code / Codex / Copilot / OpenCode, or any custom agent via ACP. Single Node.js process, no Docker, no Redis.

> **Naming**: Agim ⟵ Agent + IM (with a hint of "agile"). Chinese name 阿吉姆.
> npm package: **`agim-cli`** (the unscoped `agim` is reserved by npm's
> anti-typosquat policy); the installed binary is **`agim`** — that's what
> you type. The legacy `im-hub-pro` bin name is kept as an alias so existing
> systemd units / shell aliases keep working unchanged.
> On-disk paths default to **`~/.agim/`** for fresh installs but auto-detect
> and continue using a pre-existing **`~/.agim/`** if one is present.
> Env vars (`IMHUB_*`), HTTP headers (`X-IM-Hub-Token`), and the systemd
> unit `im-hub.service` retain their legacy names for drop-in compatibility
> with installations from the 0.x line — see [Migrating](#migrating).

## Highlights

- **5 messengers + email, 4+ agents** — WeChat (image / file / voice), Feishu, DingTalk (image / voice with server-side ASR), Telegram, Discord, Email (SMTP); Claude Code, Codex, Copilot, OpenCode, plus any ACP endpoint
- **Agent-to-Agent (A2A)** — agents call other agents inline via `mcp__imhub__call_agent`. Just say *"用 codex 帮我跑 git status"* / *"ask opencode to run the tests"* — the active agent hands off, waits, integrates the reply. Guardrails: depth limit (default 3), self-call ban, workspace whitelist, per-user budget. Observability: `/a2a stats | recent | tree <id>`. Disable with `IMHUB_A2A_ENABLED=0`.
- **A2A shared artifacts (v1.1.3+)** — caller drops files into the callee's workspace via `inputs[]` (`fromAbsolutePath` / `fromCallerOutput` / inline `content`), and callee writes products to `~/.agim/artifacts/<jobId>/_agim-output/`. Returned `outputs[]` lets the caller read files on demand. Hard-link first, copy fallback. Size caps configurable.
- **IM long-message viewer (v1.1.6+)** — WeChat / Feishu and friends render rich markdown poorly. When an agent's reply exceeds the size threshold (or contains a markdown table / large code block), agim stashes the full markdown in `~/.agim/viewer.db` (permanent, local-only — content never leaves your host) and sends the IM a short summary + a link `https://<your-host>/v/<uuid>`. The link is served by agim's own web console — operator exposes the web port (cloudflared / caddy / tailscale of choice). Agents can opt in explicitly by wrapping long answers in `<im-summary>…</im-summary><full-md>…</full-md>`. Enable with `IMHUB_VIEWER_ENABLED=1` + `IMHUB_VIEWER_PUBLIC_BASE_URL=https://your-host`.
- **Crash-safe delivery** — every outbound message (replies, reminders, approvals, restart notices) flows through a SQLite outbox; a worker drains pending rows with exponential backoff. IM glitches and brief disconnects no longer drop replies. `/outbox status | list | failed | retry <id>`.
- **In-flight job recovery** — every inbound message becomes a tracked inline job (`pending → running → completed → delivered`). When agim is restarted mid-flight, the next startup pings each affected thread within 10 min: *"⚠️ 上次的消息被服务重启中断了：「…」回复 1 重发 / 2 取消"*. Per-job lifecycle visible in `/job list` and `/job check <id>`.
- **`/remind` reminders subsystem** — one-shot + recurring (`每天8点喝水`); LLM auto-detects reminder intent in casual chat; LLM polishes delivery; agent MCP tools; web `/reminders` page; email + IM delivery
- **`/memo` 5W1H persistent memory** — generic "what / who / when / where / how / why" notes with optional GPS capture (browser geolocation H5 + Baidu geocoder); permanent by default, transient bucket for parking spots / today's meeting; agents store + retrieve via MCP tools so casual mentions get remembered automatically
- **Browser dashboard** — chat UI; Tasks panel with 10 tabs (jobs / background / subtasks / schedules / approvals / health / files / audit / **outbox / a2a**); reminders panel; memos panel; settings page with workspace CRUD. Bilingual (EN / 中文) with per-page lang switcher and contextual `(?)` help tooltips on jargon (v1.1.4+)
- **Human-in-the-loop tool approval** — Claude tool calls pause for `y`/`n` in IM or in-page card; works across all platforms
- **Rich media in WeChat / Telegram / DingTalk** — receive images, files, videos; voice messages transcribed via WeChat STT, DingTalk's server-side ASR, OpenAI Whisper, or whisper.cpp (per-platform fallback chain)
- **Smart routing** — intent classifier (CJK + ASCII), sticky sessions, circuit breaker, rate limiter
- **Multi-tenant workspaces** — per-workspace agent whitelist, rate limits, command-level ACL
- **Persistent jobs & cron** — SQLite-backed, survives restarts, 30-day retention (24h for auto-tracked inline jobs)
- **Observability** — structured logging (pino + traceId), Prometheus metrics, audit log
- **Security** — timing-safe auth, SSRF guards, credential file permissions, approval socket entropy

See [CHANGELOG.md](CHANGELOG.md) for the full version history.

## Quick Start

```bash
npm install -g agim-cli      # Requires Node.js ≥ 18 (≥ 22 LTS recommended)

# Configure at least one messenger
agim                            # arrow-key wizard (recommended) — picks language,
                                # then per-component setup for every messenger / agent
                                # — or use the legacy per-component commands below:
agim config wechat              # QR-code login
agim config feishu              # App ID + Secret (no webhook needed)
agim config dingtalk            # ClientID + ClientSecret (Stream-mode bot)
agim config telegram            # @BotFather token
agim config discord             # Bot token; see docs/discord-setup.md

# (Optional) Connect a custom remote agent over ACP
agim config agent

# Start the bridge
agim start
```

Web UI at `http://localhost:3000` — chat at `/`, tasks at `/tasks`, settings at `/settings`.

### Migrating

#### From the original `agim`
```bash
npm uninstall -g im-hub
npm install -g agim-cli
agim start            # config, env vars, headers all unchanged
```

#### From `agim` (0.x → 1.0)
```bash
npm uninstall -g im-hub-pro
npm install -g agim-cli
agim start            # same config dir, same env vars, same headers
```

The npm package is named `agim-cli` (the unscoped name `agim` is reserved
by npm's anti-typosquat policy); the **binary** it installs is `agim`,
which is what you'll actually type. `agim` is also retained as a
binary alias inside the package, so previous shell aliases and systemd
units that call `agim` continue to work without any extra setup.

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
| **ACP** | Client (connect to remote agents) + Server (Agim itself as an ACP agent) |

## CLI Commands

```
agim                       # Arrow-key wizard (bilingual zh/en) — recommended entry
agim start                 # Start the bridge + web UI (foreground)
agim start --bg            # Start as a background daemon
agim status                # Show service status (systemd / bg / fg)
agim restart               # Restart the running service
agim stop                  # Stop the running service
agim uninstall             # Uninstall (keeps ~/.agim-workspaces/)
agim config wechat         # Configure WeChat
agim config feishu         # Configure Feishu
agim config dingtalk       # Configure DingTalk (Stream-mode internal app)
agim config telegram       # Configure Telegram
agim config discord        # Configure Discord
agim config claude         # Configure Claude Code
agim config agent          # Connect a custom ACP agent
agim agents                # List available agents
agim messengers            # List available messengers
# (`im-hub-pro …` continues to work as a deprecated alias)
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
| `/outbox status\|list\|failed\|retry <id>` | Inspect & operate the persistent IM delivery queue (v1.1.2+) |
| `/a2a stats\|recent\|tree <id>` | Agent-to-Agent observability — chain, latency, callee histogram (v1.1.2+) |
| `/router status\|explain` | Inspect routing decisions |
| `y` / `n` / `批准` / `拒绝` | Approve / deny Claude tool call (or reminder confirmation card) |
| `1` / `2` | After a service restart, reply `1` to redo the interrupted message or `2` to cancel (10 min window) |

## Human-in-the-loop Tool Approval

When a Claude run tries to use a tool, Agim pauses and sends an approval card:

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

**Three creation paths** (all land in the same `~/.agim/reminders.db`):

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
`~/.agim/config.json` (validated by zod at startup):

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
| `IMHUB_TELEGRAM_COORDS_GCJ02` | unset | Set to `1` to apply GCJ-02 → WGS-84 to Telegram native location/venue messages. Default off (WGS-84 pass-through). Turn on if your Telegram clients are Apple devices in mainland China — iOS Core Location applies the GCJ offset before handing coords to Telegram. |
| `IMHUB_H5_COORDS_GCJ02` | unset | Set to `1` to apply GCJ-02 → WGS-84 to coords POSTed from `/memo here` H5 capture pages. Default off (WGS-84 pass-through, fits WeChat X5 webview + Android Chrome). Turn on if your users open the H5 link in iOS Safari / iOS WebKit in mainland China. See [`src/core/coord-systems.ts`](src/core/coord-systems.ts) for the full per-platform policy. |
| `AGIM_HOME` | auto | Per-user state directory. By default Agim picks `~/.agim/` on a fresh install and `~/.im-hub/` on a legacy 0.x install (auto-detected). Set explicitly if you want to pin a location — e.g. on shared machines or for tests. `IMHUB_HOME` is also honored. |
| `AGIM_WORKSPACES` | auto | Per-agent workspace root. Same dual-detect logic as `AGIM_HOME` (`~/.agim-workspaces/` preferred, `~/.im-hub-workspaces/` if it exists). `IMHUB_WORKSPACES` also honored. |

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
| v0.5.0–0.5.2 | Bilingual arrow-key `agim` wizard (then `im-hub-pro` pre-rename); per-component flows (QR for WeChat, credentials prompts for Feishu / Telegram / Discord; live install detection for agents); systemd-unit env fallback for SMTP / Baidu prefill; full service lifecycle commands (`status / start --bg / restart / stop / uninstall`) |
| v0.6.0 | DingTalk Stream-mode adapter — bidirectional bot bridge via WebSocket, image inbound (`messageFiles/download` → claude-code multimodal Read), voice inbound (server-side ASR `recognition` field, whisper.cpp fallback) |
| v0.6.3 | Per-platform coord-system handling for native location messages (Telegram defaults WGS pass-through; H5 WGS pass-through fixes WeChat-X5 markers; DingTalk routes Baidu link URLs through BD-09→WGS) |
| **v1.0.0** | Brand rename to **Agim · 阿吉姆**. New canonical bin `agim`; `im-hub-pro` retained as deprecation alias. On-disk paths / env vars / HTTP headers / systemd unit name kept stable for drop-in compat with 0.x installs. |

### v1.1.0 (next)

- [ ] Slack adapter
- [ ] Feishu / DingTalk / Discord button-style approval cards
- [ ] Multi-instance event bus (Redis Streams / NATS)
- [ ] Workspace member picker UI

## Community

<p align="center">
  <a href="https://deepseek.club/community/imhub">
    <img src="https://deepseek.club/assets/logo-DH6LfKkF.png" style="width: 150px; height: auto;" alt="DeepSeek">
  </a>
</p>

## License

MIT
