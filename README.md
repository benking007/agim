# Agim · Universal IM-to-Agent Bridge

[中文说明](README.zh-CN.md)

Agim connects IM channels to AI agents with one Node.js process.
It is designed for production use: at-least-once persistent delivery, session continuity, human approval, and observable operations.

## What matters

- **Bridge first**: WeChat / Feishu / DingTalk / Email to multiple agent backends. Telegram / Discord stay hidden unless `AGIM_ENABLE_GLOBAL_IM=1`.
- **Agent flexibility**: Claude Code, Codex, GitHub Copilot CLI, OpenCode, Cursor, Kimi Code, Qoder, PI, MiMo Code, Antigravity, and Agim Agent (in-process LLM).
- **AI workflows built-in**: memory, skills, Focus, Loop Engineering, Subagents (`call_agent` / `call_agents`), heartbeat, reminders, memos, ask-user.
- **Reliable runtime**: SQLite outbox (at-least-once delivery), restart recovery, job board, structured audit. Production requires native `better-sqlite3`; without it the outbox is unavailable.
- **Safety by default**: token auth, sensitive-path denylist. Tool auto-approve is **off** by default; opt in with `AGIM_AUTO_APPROVE=1` (and a strict sender allowlist when IM is enabled).

## Quick start

Requires **Node.js ≥ 22.19**. A C++ toolchain (`gcc/g++`, `make`, `python3`) is needed so `better-sqlite3` can compile on install.

After install, run `agim` (or `agim go`). The first command starts the service and opens the browser wizard: pick a model, paste one API key, then chat.

```bash
npm install -g agim-cli
agim
```

First run will:

1. Detect usable local agents such as Claude Code, Codex, GitHub Copilot CLI, Cursor, Kimi Code, Qoder, PI, MiMo Code, Antigravity, or Agim Agent.
2. If none are ready, start Agim and open `http://localhost:3000/setup` so you can pick DeepSeek / Kimi / GLM / MiMo / Ollama and paste one API key.
3. Print the Web console URL. On first boot a one-time token is written to `~/.agim/web-bootstrap-token` (retrieve with `agim token bootstrap` if needed). Loopback (`127.0.0.1`) usually skips login.

Default Web console: `http://localhost:3000` · first-run wizard: `/setup`  
Skip writes `setupSkipped` and leaves `/setup` available. Details: [`docs/first-run-setup.md`](docs/first-run-setup.md).

- Chat: `/`
- Mobile Portal: `/m/chat` (`/` Skills·Commands, `@` workspace refs, Focus / Loop docks — see [`docs/portal-composer.md`](docs/portal-composer.md))
- Native shells: iOS [`apps/ios`](apps/ios) · macOS [`apps/macos`](apps/macos) (both wrap `/m/chat`; see [`docs/macos-shell.md`](docs/macos-shell.md))
- Tasks: `/tasks` (Loop audit at `/tasks/loops`)
- Settings: `/settings`

If you forget the URL or token path:

```bash
agim web
```

Local health check:

```bash
agim doctor
```

After the Web chat works, connect WeChat / Feishu / DingTalk from Settings.
`agim quickstart` is kept as a compatibility alias.

Common CLI entries:

| Command | When to use |
|---|---|
| `agim` | First run opens setup; later runs show the entry menu |
| `agim go` | Start the service and open the first-run wizard (or chat, if an agent is already ready) |
| `agim web` | Recover the console URL, service state, or token path |
| `agim web --open` | Open the Web console in your default browser |
| `agim web --start --open` | Start the background service and open Web in one step |
| `agim config` | Continue setup: Agent, IM, Web, admins |
| `agim doctor` | Explain what is not ready locally |
| `agim start --bg` / `status` / `restart` / `stop` | Service operations after setup |

## Choose your AI backend

| Scenario | Recommended path |
|---|---|
| Strong coding agent loop | `claude-code` / `codex` / `copilot` / `opencode` / `cursor` / `kimi-code` / `qoder` / `pi` / `mimo` / `antigravity` |
| API-only, low-cost in-process mode | `agim` (alias `native`) + `llmBackends` |

Agim Agent setup details: `docs/llm-backends.md` (DeepSeek V4: §8.1 compat, §8.2 API protocol / beta, §8.3 RPC).

Supported agent details: `docs/agents.md`

## Core AI workflows

| Capability | Description | Docs |
|---|---|---|
| Long-term memory | facts + persona, optional vector retrieval | `docs/memory-and-vector.md` |
| Skills | shared `SKILL.md` capability layer across agents | `docs/skills.md` |
| Focus | per-thread attention anchor (`/focus`) | `docs/architecture/focus.md` |
| Loop Engineering | align → dispatch → verify (`/loop`; Agim sticky parent; Portal docks) | `docs/architecture/loop-engineering.md` |
| Subagent / A2A | nested `call_agent` / `call_agents` + specialty profiles | `docs/architecture/subagent.md`, `docs/architecture/agent-profiles.md` |
| Heartbeat | periodic proactive loop (`/heartbeat`) | `docs/architecture/heartbeat.md` |
| Ask user | structured agent→user choices | `docs/ask-user.md` |
| Reminders | one-shot / recurring reminders | `docs/architecture/reminders.md` |
| Memos | 5W1H persistent notes with optional location | `docs/im-workspaces-guide.md` |

## Security defaults

- Web token auth enabled by default.
- Auto-approve **disabled** by default (`AGIM_AUTO_APPROVE=0`): mutating tools go through IM/Web approval cards. Set `AGIM_AUTO_APPROVE=1` for single-operator convenience; with IM messengers configured, also set a strict `AGIM_ALLOWED_USERS=platform:userId,...` (or acknowledge open IM with `AGIM_AUTO_APPROVE_OPEN_IM=1`).
- Sensitive files/paths are denied by policy (hard-deny, cannot be overridden).
- Self-protect prevents agents from killing/restarting agim.
- Chat `/restart` is **IM-admin only**. Web console and Portal `/m/chat` refuse it; use Settings → Service → Restart or `agim restart` ([`docs/runbook.md`](docs/runbook.md) §4).
- Telegram / Discord require `AGIM_ENABLE_GLOBAL_IM=1` (domestic defaults keep them off).

Security reference: `docs/security-hardening.md`

## Essential chat commands

| Command | Purpose |
|---|---|
| `/cc` `/oc` `/cx` `/co` `/cs` `/kimi` `/qd` `/pi` `/mimo` `/agy` `/na` … | Route to a target agent |
| `/new` | Start a new conversation session |
| `/focus` `/loop` `/plan` | Focus, Loop Engineering, Plan mode |
| `/skill` `/skills` | Skills |
| `/model` `/models` | Inspect/switch model (where supported) |
| `/abort` | Stop the running agent turn |
| `/btw ...` | Side question (bypass queue) |
| `/approval` | Session approval rules |
| `/heartbeat` `/remind` `/memo` | Schedulers & notes |
| `/job` `/cron` `/audit` `/stats` `/outbox` `/a2a` | Runtime / delivery / A2A visibility |
| `/agents` `/help` `/status` | Discovery & service status |
| `/restart` `/stop` | IM-admin service control (refused on Web/`/m/chat`) |

Type `/help` in chat for the full list.

## Minimal config shape

`~/.agim/config.json`

```json
{
  "messengers": [],
  "agents": ["agim", "claude-code"],
  "defaultAgent": "agim",
  "llmBackends": [
    {
      "name": "default-agim",
      "provider": "openai-compat",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini"
    }
  ],
  "llmRoles": {
    "cheap": "default-agim",
    "finance": "default-agim"
  }
}
```

IM is optional — leave `messengers` empty for web-console-only, then add WeChat / Feishu / DingTalk from Settings or `agim config`.

Secrets are stored separately from this file. Task dispatch (coding / finance / collect) can be configured via dropdowns under **Settings → LLM → Task dispatch cheat sheet** (see [`docs/llm-backends.md`](docs/llm-backends.md) §6.1).

## Operations

- Deployment guide: `docs/deployment.md`
- Runbook: `docs/runbook.md`
- Architecture stance: `docs/architecture-bridge-and-agim-agent.md`
- LLM backends & dispatch cheat sheet: `docs/llm-backends.md`
- Local Unix RPC (opt-in `llm_complete` / static token for same-host services): see `CHANGELOG.md` Unreleased
- Full changelog: `CHANGELOG.md`

## Docs index

Start from: `docs/README.md`

## Migration notes

Current public surfaces use the Agim naming consistently:

- executable: `agim`
- environment variables: `AGIM_*`
- data paths: `~/.agim` and `~/.agim-workspaces`

`/goal` is retired — use Focus (`/focus`) and Loop (`/loop`) instead (`docs/goals.md`, `docs/architecture/focus.md`).

## Development

```bash
git clone https://github.com/benking007/agim.git
cd agim
npm ci
npm --prefix src/web-app ci
npm run build
npm run lint
npm run typecheck
npm test
```

## License

MIT
