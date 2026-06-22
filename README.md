# Agim · Universal IM-to-Agent Bridge

[中文说明](README.zh-CN.md)

Agim connects IM channels to AI agents with one Node.js process.
It is designed for production use: persistent delivery, session continuity, human approval, and observable operations.

## What matters

- **Bridge first**: WeChat / Feishu / DingTalk / Email to multiple agent backends.
- **Agent flexibility**: Claude Code, Codex, OpenCode, Cursor, Antigravity, native LLM, and ACP remote agents.
- **AI workflows built-in**: memory, skills, goals, heartbeat scheduler, reminders, memos, ask-user.
- **Reliable runtime**: SQLite outbox, restart recovery, job board, structured audit.
- **Safety by default**: token auth, approval gate, sensitive-path denylist, optional global-IM disable.

## Quick start

```bash
npm install -g agim-cli
agim                         # interactive setup wizard
agim start
```

Web console: `http://localhost:3000`

- Chat: `/`
- Tasks: `/tasks`
- Settings: `/settings`

## Choose your AI backend

| Scenario | Recommended path |
|---|---|
| Strong coding agent loop | `claude-code` / `codex` / `opencode` / `cursor` |
| API-only, low-cost native mode | `native` + `llmBackends` |
| Bring your own remote agent | ACP (`acpAgents`) |

Native setup details: `docs/llm-backends.md`

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
- Approval gate enabled by default.
- Sensitive files/paths are denied by policy.
- Global IM connectors can stay disabled in domestic deployments.

Security reference: `docs/security-hardening.md`

## Essential IM commands

| Command | Purpose |
|---|---|
| `/cc ...` `/oc ...` `/cx ...` `/cs ...` `/na ...` | Route to a target agent |
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
  "messengers": ["wechat-ilink"],
  "agents": ["claude-code", "native"],
  "defaultAgent": "claude-code",
  "llmBackends": [
    {
      "name": "default-native",
      "provider": "openai-compat",
      "baseUrl": "https://api.openai.com/v1",
      "model": "gpt-4o-mini"
    }
  ],
  "llmRoles": {
    "cheap": "default-native"
  }
}
```

Secrets are stored separately from this file.

## Operations

- Deployment guide: `docs/deployment.md`
- Runbook: `docs/runbook.md`
- Architecture stance: `docs/architecture-bridge-and-native.md`
- Full changelog: `CHANGELOG.md`

## Docs index

Start from: `docs/README.md`

## Migration notes

Legacy installs remain compatible:

- command alias compatibility retained
- legacy env naming retained
- old data path autodetected

## Development

```bash
git clone https://github.com/benking007/agim.git
cd agim
npm install --no-package-lock
npm --prefix src/web-app install
npm run build
npm run lint
npm run typecheck
npm test
```

## Community

<p align="center">
  <a href="https://deepseek.club/community/imhub">
    <img src="https://deepseek.club/assets/logo-DH6LfKkF.png" style="width: 150px; height: auto;" alt="DeepSeek">
  </a>
</p>

## License

MIT
