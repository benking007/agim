# Agim · Universal IM-to-Agent Bridge

[中文说明](README.zh-CN.md)

Agim connects IM channels to AI agents with one Node.js process.
It is designed for production use: at-least-once persistent delivery, session continuity, human approval, and observable operations.

## What matters

- **Bridge first**: WeChat / Feishu / DingTalk / Email to multiple agent backends.
- **Agent flexibility**: Claude Code, Codex, GitHub Copilot CLI, OpenCode, Cursor, Kimi Code, Qoder, PI, MiMo Code, Antigravity, Agim Agent (in-process LLM), and ACP remote agents.
- **AI workflows built-in**: memory, skills, goals, heartbeat scheduler, reminders, memos, ask-user.
- **Reliable runtime**: SQLite outbox (at-least-once delivery), restart recovery, job board, structured audit. Production requires native `better-sqlite3`; without it the outbox is unavailable.
- **Safety by default**: token auth, sensitive-path denylist, optional global-IM disable. Tool auto-approve is on by default (single-operator); tighten for untrusted IM using the hardening checklist.

## Quick start

Requires **Node.js ≥ 22.19**. A C++ toolchain (`gcc/g++`, `make`, `python3`) is needed so `better-sqlite3` can compile on install.

You do not need to configure IM, systemd, tokens, or workspaces first.
Start with the smallest loop: Web console + one working agent.

```bash
npm install -g agim-cli
agim go
```

`agim go` will:

1. Detect usable local agents such as Claude Code, Codex, GitHub Copilot CLI, Cursor, Kimi Code, Qoder, PI, MiMo Code, or Agim Agent.
2. Help configure an Agim Agent model API if no agent is ready yet.
3. Start Agim in the background and print the Web console URL. On first boot a one-time token is written to `~/.agim/web-bootstrap-token` (retrieve with `agim token bootstrap` if needed). Loopback (`127.0.0.1`) usually skips login.

Default Web console: `http://localhost:3000`

- Chat: `/`
- Tasks: `/tasks`
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
| `agim` | Open the guided entry menu when you are unsure what to run |
| `agim go` | First install: get one agent + Web working |
| `agim web` | Recover the console URL, service state, or token path |
| `agim web --open` | Open the Web console in your default browser |
| `agim web --start --open` | Start the background service and open Web in one step |
| `agim config` | Continue setup: Agent, IM, Web, admins |
| `agim doctor` | Explain what is not ready locally |
| `agim start --bg` / `status` / `restart` / `stop` | Service operations after setup |

## Choose your AI backend

| Scenario | Recommended path |
|---|---|
| Strong coding agent loop | `claude-code` / `codex` / `copilot` / `opencode` / `cursor` / `kimi-code` / `qoder` / `pi` / `mimo` |
| API-only, low-cost in-process mode | `agim` (alias `native`) + `llmBackends` |
| Bring your own remote agent | ACP (`acpAgents`) |

Agim Agent setup details: `docs/llm-backends.md`

Supported agent details: `docs/agents.md`

## Core AI workflows

| Capability | Description | Docs |
|---|---|---|
| Long-term memory | facts + persona, optional vector retrieval | `docs/memory-and-vector.md` |
| Skills | shared `SKILL.md` capability layer across agents | `docs/skills.md` |
| Goals | sustained objective per thread (`/goal`) | `docs/goals.md` |
| Heartbeat | periodic proactive loop (`/heartbeat`) | `docs/architecture/reminders.md` |
| Ask user | structured agent->user choices | `docs/ask-user.md` |
| Reminders | one-shot / recurring reminders | `docs/architecture/reminders.md` |
| Memos | 5W1H persistent notes with optional location | `docs/im-workspaces-guide.md` |
| A2A | agent-to-agent calls with traceability | `CHANGELOG.md` |

## Security defaults

- Web token auth enabled by default.
- Auto-approve enabled by default (`AGIM_AUTO_APPROVE=1`): tool calls auto-approved after safety checks (sensitive-path deny + self-protect). Set `AGIM_AUTO_APPROVE=0` for manual IM approval flow.
- Sensitive files/paths are denied by policy (hard-deny, cannot be overridden).
- Self-protect prevents agents from killing/restarting agim.
- Global IM connectors can stay disabled in domestic deployments.

Security reference: `docs/security-hardening.md`

## Essential IM commands

| Command | Purpose |
|---|---|
| `/cc ...` `/oc ...` `/cx ...` `/co ...` `/cs ...` `/kimi ...` `/qd ...` `/pi ...` `/mimo ...` `/na ...` | Route to a target agent |
| `/new` | Start a new conversation session |
| `/model` `/models` | Inspect/switch model (where supported) |
| `/goal ...` | Manage per-thread long goal |
| `/heartbeat ...` | Manage heartbeat schedule |
| `/remind ...` | Manage reminders |
| `/memo ...` | Manage memo records |
| `/job ...` `/cron ...` `/audit ...` `/stats` | Runtime operations |
| `/outbox ...` | Delivery queue operations |
| `/a2a ...` | A2A runtime visibility |

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
    "cheap": "default-agim"
  }
}
```

IM is optional — leave `messengers` empty for web-console-only, then add WeChat / Feishu / DingTalk from Settings or `agim config`.

Secrets are stored separately from this file.

## Operations

- Deployment guide: `docs/deployment.md`
- Runbook: `docs/runbook.md`
- Architecture stance: `docs/architecture-bridge-and-native.md`
- Full changelog: `CHANGELOG.md`

## Docs index

Start from: `docs/README.md`

## Migration notes

Current public surfaces use the Agim naming consistently:

- executable: `agim`
- environment variables: `AGIM_*`
- data paths: `~/.agim` and `~/.agim-workspaces`

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
