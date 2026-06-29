---
name: my
description: Check the agim agent's own runtime state — current model, role, working directory, context size, available tools. Use when diagnosing "why can't you do X?" / "what model are you?" / "what's your current cwd?" / before committing to a long task.
always: false
---

# Self-awareness (`my`)

You are running as one of agim's agents (native / claude-code / codex / opencode / cursor / antigravity). When the user asks how you're configured, or you're about to attempt something whose feasibility depends on your runtime, **check before assuming**.

## What you can answer directly

| Question | How to answer |
|---|---|
| "你是哪个 agent？" | Look at the system reminder block — agim's prompt always tells you which agent you are. The active agent's name also appears in `/agents` output. |
| "用的什么模型？" | For native: read `process.env.AGIM_NATIVE_BACKEND` or run `agim model show`. For CLI agents: the model is set by the CLI itself (`/model` inside claude-code, `gpt-5` inside codex etc.). |
| "现在的 cwd？" | Each agent has a per-agent cwd under `~/.agim-workspaces/<agent>/`. Read `AGENTS.md` in that dir to see role-specific instructions; the cwd itself is set at process spawn time. |
| "context 还剩多少？" | If you're running as a CLI agent, the harness usually shows a status line. For native, recent token usage logs into `journalctl -u agim` under `event=native.turn.done`. |
| "Apps 列表？" | Run `agim agents` or use the `/agents` slash command. |

## What you can change

The user (and you, with the user's consent) can change runtime settings via slash commands. Show the user the command, do not silently mutate.

| Want to | Command |
|---|---|
| Switch agent for this thread | `/cc` (claude-code) · `/oc` (opencode) · `/cx` (codex) · `/cs` (cursor) · `/agy` (antigravity) · `/native` |
| Switch model on a CLI agent | `/model` (works for claude-code / codex / opencode / cursor) |
| Reset thread context | `/new` |
| Stop a running task | `/abort` |
| Set a sustained objective | `/goal set <title>` |
| Periodic self-check | `/heartbeat bind <body>` |

## Diagnostic checklist (when something fails)

Before saying "I can't do that", run through:

1. **Tool available?** Tell the user the literal tool name you tried; if it's missing, the operator hasn't enabled it.
2. **Skill exists?** `mcp__agim__read_skill("<name>")` returns the body; if it errors, the skill isn't installed.
3. **Network?** Try `curl -sS -o /dev/null -w "%{http_code}\n" https://www.google.com` (or a target endpoint) — agim runs on the operator's host, no proxy by default.
4. **API key?** Many skills require `ENV` vars (FINNHUB_API_KEY, MX_APIKEY, etc.). The skill summary block shows `(unavailable: ENV: X)` when missing.

## Don't lie about what you are

If the user asks something that depends on a capability you lack — say it directly:
> 我现在跑在 claude-code，没法直接执行长任务的后台守护。建议用 `/native` 或 `agim` 的 bgjob。

That's more useful than guessing.
