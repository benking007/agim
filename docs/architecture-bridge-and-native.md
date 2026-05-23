# Architecture: bridge agent + native agent are peers

> Why does agim have both a "bridge" mode and a "native" agent? Are they
> two separate products?

**No.** agim is, and continues to be, a **messenger-to-agent bridge**.
The native agent introduced in Stage 1-5 is just another `AgentAdapter`
in the registry — peer-equal to `claude-code`, `codex`, `opencode`, and
`antigravity`. The only thing that's "special" about it is **where it
runs** (in-process LLM loop, no subprocess spawn).

This doc explains the architecture, the invariants, and the practical
consequences for operators + contributors.

## 1. The product is the bridge

agim's reason to exist:

> Take any IM channel a user already lives in (WeChat / Feishu / DingTalk
> / Telegram / Discord / Web) and connect it to a powerful Agent
> backend — without the user having to leave their phone.

Everything in agim — message routing, sticky sessions, approval cards,
reminders, memos, goals, heartbeat, A2A, MCP integration, skills loader,
ask-user, viewer rendering — exists to support that bridge.

The **product identity** is the bridge. That doesn't change.

## 2. AgentAdapter is the universal interface

Every "agent backend" agim talks to implements one tiny interface:

```ts
export interface AgentAdapter {
  readonly name: string
  readonly aliases: string[]
  readonly kind?: 'cli' | 'in-process' | 'remote'
  sendPrompt(sessionId, prompt, history?, opts?): AsyncGenerator<string>
  isAvailable(): Promise<boolean>
  describe?(): string | undefined
}
```

That's it. The whole rest of agim (router, approval bus, A2A,
heartbeat, /goal, /skill, /router compare, audit log, web dashboard…)
talks to backends only through this interface — never through
"is this CLI?" or "is this native?" branches.

This is the load-bearing architectural decision. Once a backend
implements `AgentAdapter`, every existing agim feature works on it
automatically.

## 3. `kind` is a UI tag, not a code path

```
'cli'         spawns an external CLI subprocess per turn
              (Claude Code, Codex, OpenCode, Antigravity)
'in-process'  runs entirely inside the agim process via the native
              LLM client + agent loop (the `native` adapter)
'remote'      talks to an external Agent Client Protocol endpoint
              over the network (acp-* adapters)
```

`kind` is **only consulted by operator-facing UI** (`/agents` listing,
boot banner, web dashboard pretty-printing). The router does NOT branch
on it. The approval bus does NOT branch on it. A2A does NOT branch on
it.

Pre-existing adapters that don't set `kind` are treated as `'cli'` —
this matches every built-in shipped before Stage 1, and keeps any
out-of-tree adapter that someone wrote against the old interface
compatible without recompile.

## 4. The peers

The current registry (as of Stage 6):

| name | aliases | kind | implementation |
|---|---|---|---|
| `claude-code` | `/cc`, `/claude`, `/claudecode` | `cli` | `claude-code` CLI subprocess + JSONL stdio |
| `codex` | `/cx`, `/openai`, `/codexcli` | `cli` | `codex exec` subprocess |
| `opencode` | `/oc`, `/opencodeai` | `cli` | opencode CLI (stdio or HTTP daemon) |
| `antigravity` | `/agy`, `/gemini`, `/ag` | `cli` | Google Antigravity CLI |
| `native` | `/na`, `/llm`, `/native-llm` | `in-process` | LLM client + agent loop (no subprocess) |
| (per-config) | per-config | `remote` | ACP endpoint over HTTP |

`/agents` renders every row with its `kind` tag and a one-line
`describe()` so the user sees at a glance:

```
🤖 Available Agents

• /claude-code [cli] (/cc, /claude, /claudecode)
• /codex       [cli] (/cx, /openai, /codexcli)
• /opencode    [cli] (/oc, /opencodeai)
• /native      [in-process] (/na, /llm, /native-llm) — role=native-chat -> openai-compat:deepseek-chat
```

## 5. The Six Things You Get Automatically

Because native is just another `AgentAdapter`, every agim feature
works without per-feature wiring. Concretely:

### 5a. Routing

The same `resolveActiveAgent` picks among them. `defaultAgent: 'native'`
is a valid config. `/cc`, `/cx`, `/oc`, `/na` all switch sticky session.

### 5b. A2A (cross-agent calls)

`mcp__imhub__call_agent('native', '...')` works. So does
`mcp__imhub__call_agent('claude-code', '...')` from inside native.
You can mix and match freely:

```
user → claude-code (heavy planning)
       → call_agent('native', 'extract 50 keywords from these docs')
       → call_agent('opencode', 'apply these patches')
```

```
user → native (cheap intent classifier)
       → call_agent('claude-code', 'now write the production code')
```

### 5c. Approval / MCP / Skills

Approval bus, MCP tool dispatch, SKILL.md tier-1 injection, the
notification evaluator, the `/goal` + `/heartbeat` + `/memo` +
`/remind` prompt injections — every one of them runs at the
`AgentAdapter.sendPrompt` layer or above. Native gets all of it without
adding a single conditional.

### 5d. Web admin panels (Stage 6)

The `/settings/llm`, `/settings/mcp`, and `/settings/native-agent`
panels treat native exactly like the CLI agents:

- `/settings/llm` — list / add / remove LLM backends; bind to roles
  (`cheap` / `evaluator` / `native-chat`); per-backend **Ping** button
  via `/api/llm/backends/:name/ping`.
- `/settings/mcp` — list / add / remove external MCP servers (stdio
  or HTTP/SSE); per-server **Health** button via
  `/api/mcp/servers/:name/health`. Tools flow into the native agent's
  dispatcher with `mcp_<server>_<tool>` naming.
- `/settings/native-agent` — focused form for the 4 native-agent env
  knobs + 2 notification-evaluator + 3 heartbeat knobs (lifted out of
  the generic env editor).

### 5e. Audit / cost / sessions

Every turn lands in `invocations` with `agent='native'` (or
`agent='claude-code'`, etc.) — the dashboard sums them the same way.
Sticky sessions store `agent='native'` and resume correctly.

### 5f. `/router compare` A/B evaluation

`/router compare agent:claude-code agent:native "..."` works on day
one. There's no special "compare CLI vs native" code — both sides go
through the same `BackendRef.kind='agent'` branch.

### 5g. Fallback chains

Stage 5's `tryIntrospectChain` can cascade through LLM roles; the
analogous "if CLI is down, fall back to native" lives in the same
circuit-breaker layer that handles CLI-to-CLI fallback. No native
exception.

## 6. When to use which (operator guidance)

| scenario | recommended |
|---|---|
| User-facing, complex multi-step work | a CLI agent (Claude Code / Codex) |
| Cheap internal introspection (memo extract, intent class) | native (`role=cheap`) |
| Local-first / no-egress requirement | native with a local Ollama backend |
| Need a model the CLI agents don't support (DeepSeek, GLM, Kimi) | native (or opencode for limited support) |
| Operator wants the same prompt → 2 backends to pick a winner | `/router compare` |
| Long-running monitoring loop that pings on actionable updates | `/heartbeat` (uses cheap LLM + evaluator gate) |
| Disambiguation question from agent to user | `mcp__imhub__ask_user` |

## 7. Anti-patterns (do NOT do these)

- ❌ Don't add `if (adapter.kind === 'in-process') ...` in router /
  approval / A2A / audit code. If you find yourself wanting to, the
  feature belongs in the `AgentAdapter` interface (extend it) or in
  the adapter itself.
- ❌ Don't write a parallel "native router" / "native approval bus".
  There is one router, one approval bus.
- ❌ Don't make `native` a hardcoded default; respect the operator's
  `defaultAgent` config like any other backend.

## 8. Future evolution

The peer model gives us a clean upgrade path:

- **More CLI backends** — just implement `AgentAdapter` with
  `kind='cli'`. Drop in `src/plugins/agents/<name>/` and register.
- **More native models** — add a provider in `src/core/llm/`,
  reference it in `llmRoles`, native picks it up automatically.
- **Remote backends** — register an ACP-compatible endpoint with
  `kind='remote'`; same A2A / approval / skills behaviour.
- **Hosted agents** — if a SaaS exposes an agent API tomorrow, write
  one adapter and the entire agim feature set works against it.

The bridge identity stays. The peer set grows.

## 9. TL;DR

> agim = **messenger ↔ agent bridge**.
> All agent backends — CLI, in-process native, remote ACP — are peer
> `AgentAdapter` implementations. `kind` is a UI tag, not a code path.
> Every existing feature (routing, A2A, approval, skills, goal,
> heartbeat, ask_user, /router compare) works on every peer
> automatically.
