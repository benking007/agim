# Agent backends

Agim can bridge one IM entry to multiple local or remote agent backends. This page is the user-facing map for choosing, installing, and operating those backends.

For the implementation checklist used when adding a new backend, see `agent-integration-sop.md`.  
When Agim dispatches work to a non-Agim CLI via `call_agent(s)`, specialty fit comes from [`architecture/agent-profiles.md`](./architecture/agent-profiles.md) (Settings → Agents →「派工能力画像」).

**Subagent dispatch:** sticky CLI parents can spawn nested workers via `mcp__agim__call_agent` / `call_agents` (shared MCP sidecar; PI uses its extension). **Loop Engineering (`/loop`) stays Agim-only** — switch sticky to Agim before starting a Loop. SSOT: [`architecture/cli-subagent-dispatch.md`](./architecture/cli-subagent-dispatch.md).

## Supported backends

| Agent ID | IM aliases | Install / login hint | Model switch | Agim tools |
|---|---|---|---|---|
| `agim` (alias `native`) | `/agim`, `/na`, `/llm` | No external CLI. Configure `llmBackends`. | Yes | In-process tools **+ Loop parent** |
| `claude-code` | `/cc`, `/claude` | Install Claude Code, then complete its login flow. | CLI default | MCP + approval + **Subagent dispatch** |
| `codex` | `/cx` | Install Codex CLI, then complete its login flow. | CLI default | MCP + approval + **Subagent dispatch** |
| `copilot` | `/co`, `/gh-copilot`, `/github-copilot` | `npm install -g @github/copilot`, then `copilot login`. | Yes | MCP + approval + **Subagent dispatch** |
| `opencode` | `/oc` | Install OpenCode and configure providers. | Yes | MCP + approval + **Subagent dispatch** |
| `cursor` | `/cs`, `/cur` | Install `cursor-agent`, then `cursor-agent login`. | Yes | MCP + approval + **Subagent dispatch** |
| `kimi-code` | `/kimi`, `/km` | Install Kimi Code, then run `kimi` once to login. | Yes | MCP + approval + **Subagent dispatch** |
| `qoder` | `/qd`, `/qodercli` | Install Qoder CLI, then `qodercli login`. | Yes | MCP + approval + **Subagent dispatch** |
| `pi` | `/pi`, `/pi-agent` | Install PI CLI and complete auth. | Yes | Extension bridge + approval + **Subagent dispatch** |
| `mimo` | `/mo`, `/mimo-code` | Install MiMo Code, then `mimo auth login`. | Yes | MCP + approval + **Subagent dispatch** |
| `antigravity` | `/agy`, `/gemini`, `/ag` | Install Antigravity CLI, then run `agy` once to login. | CLI default | MCP + approval + **Subagent dispatch** |
`/models` and `/model` work only for agents with a model driver. If an agent is listed as `CLI default`, set the model in that CLI's own configuration.

## First setup flow

1. Run `agim` (or `agim go`).
2. If no CLI agent is on PATH, the browser opens `http://localhost:3000/setup`. Pick a model and paste one API key (or choose local Ollama).
3. If a CLI agent is already installed, Agim starts the service and opens chat instead.
4. Send the first Web message.
5. After Web chat works, enable IM channels from Settings.

`/setup` stays available later. Advanced CLI: `agim config` / `agim setup-llm` / `agim doctor`.  
Details: [`first-run-setup.md`](./first-run-setup.md).

## Workspaces and memory

IM-launched CLI agents run in isolated workspaces:

```text
~/.agim-workspaces/<agent>/
```

This avoids polluting the user's normal terminal projects and lets each agent keep its own `AGENTS.md` / `CLAUDE.md` / `MEMORY.md` context. The Web workspace page can create memory files; Agim links those files into the corresponding agent workspace so CLI agents can consume them.

Override the workspace for a specific agent with:

```bash
AGIM_<AGENT_ID>_CWD=/path/to/workspace
```

For example:

```bash
AGIM_QODER_CWD=/srv/agim/qoder
```

## Tool safety

Agim tools include memory, memo, reminder, ask-user, push message, A2A, skills, web search/fetch, and approval-gated file or command tools.

For CLI agents, tool calls must carry a live `runId` and `RunContext` so Agim can route approvals and user-scoped tools back to the correct IM thread. Mutating actions should go through Agim's approval layer:

- `agim_bash`
- `agim_write`
- `agim_edit`

Those proxy tools render an approval card before running the native dispatcher. They also reuse sensitive-path checks, audit records, auto-allow rules, and timeout behavior.

The in-process Agim Agent advertises the same capabilities as native tools: `agim_write_file` and `agim_edit_file` (exact string replace; prefer edit for small changes).

## Session continuity

Agents with native sessions store one session id per Agim conversation. `/new` clears those native session ids and starts fresh.

This is important for IM use: Agim should not simply resend old history forever. When a CLI has a native session store, Agim passes the saved session id back to the CLI and lets that CLI resume its own conversation.

## Adding another agent

Use `agent-integration-sop.md` before writing code. The short version:

1. Research the CLI with a real local run.
2. Implement `src/plugins/agents/<agent>/index.ts`.
3. Register the adapter and all user-facing metadata.
4. Wire session persistence in `types`, `session`, `router`, `cli.ts`, and A2A.
5. Wire tool injection or clearly document the limitation.
6. Confirm Skills, Memory, Memo, Reminder, Ask, Push, and A2A behavior.
7. Add adapter, Web, session, tool, and model-driver tests.
