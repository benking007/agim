# Architecture: bridge agents + Agim Agent are peers

> Why does agim have both a "bridge" mode and an "Agim Agent"? Are they
> two separate products?

**No.** agim is, and continues to be, a **messenger-to-agent bridge**.
The **Agim Agent** (registry id: `agim`; legacy routing/config alias: `native`)
is just another `AgentAdapter` in the registry — peer-equal to
`claude-code`, `codex`, `copilot`, `opencode`, `cursor`, `kimi-code`,
`qoder`, `pi`, `mimo`, and `antigravity`.
The only thing that's "special" about it is **where it runs**
(in-process LLM loop, no subprocess spawn).

This doc explains the architecture, the invariants, and the practical
consequences for operators + contributors.

> Naming: new configs and docs should use `agim`. `native` still routes
> and survives in older `config.json` / sessions during the compat window
> (see `migration-naming-v2.md`). Env knobs that still say `AGIM_NATIVE_*`
> are historical spellings for Agim Agent behaviour.

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
"is this CLI?" or "is this Agim Agent?" branches.

This is the load-bearing architectural decision. Once a backend
implements `AgentAdapter`, every existing agim feature works on it
automatically.

## 3. `kind` is a UI tag, not a code path

```
'cli'         spawns an external CLI subprocess per turn
              (Claude Code, Codex, OpenCode, Antigravity)
'in-process'  runs entirely inside the agim process via the
              LLM client + agent loop (the Agim Agent / `agim` adapter)
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

The current registry:

| name | aliases | kind | implementation |
|---|---|---|---|
| `claude-code` | `/cc`, `/claude`, `/claudecode` | `cli` | `claude-code` CLI subprocess + JSONL stdio |
| `codex` | `/cx`, `/openai`, `/codexcli` | `cli` | `codex exec` subprocess |
| `copilot` | `/co`, `/gh-copilot`, `/github-copilot` | `cli` | GitHub Copilot CLI (`copilot -p --output-format json`) |
| `opencode` | `/oc`, `/opencodeai` | `cli` | opencode CLI (stdio or HTTP daemon) |
| `cursor` | `/cs`, `/cur` | `cli` | Cursor Agent CLI (`cursor-agent`) |
| `kimi-code` | `/kimi`, `/km` | `cli` | Kimi Code CLI (`kimi -p --output-format stream-json`) |
| `qoder` | `/qd`, `/qodercli` | `cli` | Qoder CLI (`qodercli --print --output-format stream-json`) |
| `pi` | `/pi`, `/pi-agent` | `cli` | PI CLI (`pi --mode json -p`) |
| `mimo` | `/mo`, `/mimo-code` | `cli` | MiMo Code CLI (`mimo run --format json`) |
| `antigravity` | `/agy`, `/gemini`, `/ag` | `cli` | Google Antigravity CLI |
| `agim` | `/agim`, `/na`, `/llm`, `/native-llm` (+ alias id `native`) | `in-process` | LLM client + agent loop (no subprocess) |

`/agents` renders every row with its `kind` tag and a one-line
`describe()` so the user sees at a glance:

```
🤖 Available Agents

• /claude-code [cli] (/cc, /claude, /claudecode)
• /codex       [cli] (/cx, /openai, /codexcli)
• /copilot     [cli] (/co, /gh-copilot, /github-copilot)
• /opencode    [cli] (/oc, /opencodeai)
• /kimi-code   [cli] (/kimi, /km)
• /qoder       [cli] (/qd, /qodercli)
• /pi          [cli] (/pi-agent)
• /mimo        [cli] (/mo, /mimo-code)
• /agim        [in-process] (/agim, /na, /llm, /native-llm) — role=auto -> openai-compat:deepseek-chat
```

## 5. The Six Things You Get Automatically

Because Agim Agent is just another `AgentAdapter`, every agim feature
works without per-feature wiring. Concretely:

### 5a. Routing

The same `resolveActiveAgent` picks among them. `defaultAgent: 'agim'`
is a valid config (`native` still accepted as alias). `/cc`, `/cx`, `/oc`, `/agim` all switch sticky session.

### 5b. A2A (cross-agent calls)

`mcp__agim__call_agent('agim', '...')` works. So does
`mcp__agim__call_agent('claude-code', '...')` from inside Agim Agent.
You can mix and match freely:

```
user → claude-code (heavy planning)
       → call_agent('agim', 'extract 50 keywords from these docs')
       → call_agent('opencode', 'apply these patches')
```

```
user → agim (cheap intent classifier)
       → call_agent('claude-code', 'now write the production code')
```

### 5c. Approval / MCP / Skills

Approval bus, MCP tool dispatch, SKILL.md tier-1 injection, the
notification evaluator, the `/goal` + `/heartbeat` + `/memo` +
`/remind` prompt injections — every one of them runs at the
`AgentAdapter.sendPrompt` layer or above. Agim Agent gets all of it without
adding a single conditional.

### 5d. Web admin panels (Stage 6 + P1 follow-up)

Cross-thread admin views land under two SPA areas:

**`/tasks/*`** — runtime queue inspection:
- `/tasks/heartbeat` — every `/heartbeat bind` across threads with
  last-tick status + enable/disable. REST `/api/heartbeat/bindings`.
- `/tasks/asks` — live pending `mcp__agim__ask_user` queue with
  per-row Cancel (5s auto-refresh). REST `/api/asks/pending`.

**`/settings/*`** — configuration:

- `/settings/llm` — list / add / remove LLM backends; optional role
  bindings (`cheap` / `evaluator` / `native-chat`); per-backend **Ping**
  button via `/api/llm/backends/:name/ping`.
- `/chat` + `/m/chat` — when switching to `agim` without a usable
  backend, show a persistent setup modal (instead of transient toast),
  submit backend config in place, then auto-retry switch.
- `/settings/mcp` — list / add / remove external MCP servers (stdio
  or HTTP/SSE); per-server **Health** button via
  `/api/mcp/servers/:name/health`. Tools flow into the Agim Agent
  dispatcher with `mcp_<server>_<tool>` naming.
- `/settings/native-agent` — focused form for Agim Agent env
  knobs + notification-evaluator + heartbeat knobs (lifted out of
  the generic env editor; route name keeps historical `native-agent`).

### 5e. Audit / cost / sessions

Every turn lands in `invocations` with `agent='agim'` (or
`agent='claude-code'`, etc.) — the dashboard sums them the same way.
Sticky sessions store `agent='agim'` and resume correctly (legacy
`native` values still route).

### 5f. `/router compare` A/B evaluation

`/router compare agent:claude-code agent:agim "..."` works on day
one. There's no special "compare CLI vs Agim Agent" code — both sides go
through the same `BackendRef.kind='agent'` branch.

### 5g. Fallback chains

Stage 5's `tryIntrospectChain` can cascade through LLM roles; the
analogous "if CLI is down, fall back to Agim Agent" lives in the same
circuit-breaker layer that handles CLI-to-CLI fallback. No Agim Agent
exception.

## 6. When to use which (operator guidance)

| scenario | recommended |
|---|---|
| User-facing, complex multi-step work | a CLI agent (Claude Code / Codex) |
| Cheap internal introspection (memo extract, intent class) | Agim Agent (`role=cheap`) |
| Local-first / no-egress requirement | Agim Agent with a local Ollama backend |
| Need a model the CLI agents don't support (DeepSeek, GLM, Kimi) | Agim Agent (or opencode for limited support) |
| Operator wants the same prompt → 2 backends to pick a winner | `/router compare` |
| Long-running monitoring loop that pings on actionable updates | `/heartbeat` (uses cheap LLM + evaluator gate) |
| Disambiguation question from agent to user | `mcp__agim__ask_user` |

## 7. Anti-patterns (do NOT do these)

- ❌ Don't add `if (adapter.kind === 'in-process') ...` in router /
  approval / A2A / audit code. If you find yourself wanting to, the
  feature belongs in the `AgentAdapter` interface (extend it) or in
  the adapter itself.
- ❌ Don't write a parallel "Agim Agent router" / "Agim Agent approval bus".
  There is one router, one approval bus.
- ❌ Don't make `agim` (or legacy `native`) a hardcoded default; respect the operator's
  `defaultAgent` config like any other backend.

## 8. Future evolution

The peer model gives us a clean upgrade path:

- **More CLI backends** — just implement `AgentAdapter` with
  `kind='cli'`. Drop in `src/plugins/agents/<name>/` and register.
- **More models for Agim Agent** — add a provider in `src/core/llm/`; Agim Agent can
  pick it automatically once it has a usable key. `llmRoles` remains an
  optional preference layer for deterministic role routing.
- **Hosted agents** — if a SaaS exposes an agent API tomorrow, write
  one adapter and the entire agim feature set works against it.

The bridge identity stays. The peer set grows.

## 9. TL;DR

> agim = **messenger ↔ agent bridge**.
> All agent backends — CLI and in-process Agim Agent (`agim`) — are peer
> `AgentAdapter` implementations. `kind` is a UI tag, not a code path.
> Every existing feature (routing, A2A, approval, skills, goal,
> heartbeat, ask_user, /router compare) works on every peer
> automatically.

## 10. Agim Agent per-turn runtime caps

These knobs bound a **single user turn** of the in-process Agim Agent
(`agim` / legacy `native`). They are **not** Subagent / Loop delegation
budgets (`AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN` — see
[`architecture/subagent.md`](./architecture/subagent.md) §5.2).

| Env | Default | Clamp | Meaning |
|-----|---------|-------|---------|
| `AGIM_NATIVE_AGENT_MAX_TOOL_CALLS` | **100** | [1, 1000] | Max **tool invocations** this turn (parallel batches share the count). Hitting it surfaces「已达工具调用预算」. |
| `AGIM_NATIVE_AGENT_MAX_ITER` | **50** | [1, 100] | Max **model↔tools loop iterations** this turn (one iter may dispatch multiple tools). |
| `AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN` | **6** | ≥0 (`0` = off) | Max Subagent slots (`call_agent` + each `call_agents` task). Agim parent only. |

Operator UI: Settings → **Agim Agent** (`/settings/native-agent`) —
Iteration card exposes both tool-call and iteration caps; A2A card
exposes the per-turn Subagent cap. SSOT: `src/plugins/agents/agim-agent/factory.ts`
+ `src/core/subagent-parallel.ts`.

## 11. v1.2.145 — Agim Agent harness upgrade + honest deviations

A round of "harness engineering" (distilled from
[agentic-harness-patterns](https://github.com/keli-wen/agentic-harness-patterns-skill))
hardened the Agim Agent adapter **without** breaking the peer model. None of
these added a `kind`-based branch in router / approval / audit.

### 11.1 What changed in Agim Agent

| Area | Change | Where |
|---|---|---|
| Provider | Anthropic usable as an Agim Agent backend: pseudo-stream now carries complete `toolCalls` (streaming previously dropped every Anthropic tool call); baseURL strips a trailing `/v1` (the wizard preset's `…/v1` 404'd) | `anthropic-provider.ts`, `provider-base.ts` (`ChatStreamChunk.toolCalls`), `agent-loop.ts` |
| Context budget | `readOperatorRole` memoized by mtime/size; system-prompt skills list capped at `MAX_INJECTED_SKILLS` | Agim Agent adapter (`agim-agent` / historical `native/` paths) |
| Tool registry | one `assembleNativeTools()` produces defs + dispatch + a **per-call** concurrency classifier (was 3 hand-kept lists); external MCP partition name-sorted for prompt-cache stability | `tool-registry.ts`, `agent-loop.ts` (`parallelSafeClassifier`) |
| Instruction layering | operator role = `<cwd>/AGENTS.md` (project) + `<cwd>/AGENTS.local.md` (local, **wins**); `AGIM_NATIVE_AGENT_ROLE_FILE` still pins one file | Agim Agent adapter |
| Verification subagent | prompt SOP: produce a result → spin a **fresh** subagent to verify it with a self-contained brief; synthesize-before-delegate. Prompt-only — uses the existing `call_agent`, no new code path | Agim Agent adapter |
| Trust gate | `AGIM_NATIVE_TRUST_WORKSPACE=off` makes Agim Agent skip all workspace-discovered role files (multi-tenant / A2A prompt-injection defence) | Agim Agent adapter (`isWorkspaceTrusted`) |
| Audit traceId | Agim Agent now uses the inbound turn's `traceId` (plumbed via `AgentSendOpts.traceId`) instead of a self-minted id, so its audit rows correlate to the originating IM message (ADR-0002) | `types.ts`, `router.ts`, Agim Agent adapter |

### 11.2 Honest deviations from the peer model

These use hardcoded **`agim` / `native`** id checks (not
`adapter.kind`), but they still break peer symmetry unless operators
opt in / accept the documented semantics:

- **A2A in-process fast path** (`agim-dispatcher.ts`,
  `call_agent('agim')`): **default OFF**. Unset /
  `AGIM_NATIVE_CALL_AGENT_IN_PROCESS` empty → `callAgentByName` (full
  inline job + `intent:'a2a'` audit). Opt in with `=on` for the
  latency fast path (no A2A job row).
- **`isAgentEnabled('agim'|'native')` honour `config.agents`** (`live-config.ts`):
  SPA disable is a real routing kill-switch. Boot runs
  `migrateNativeAgentToggle` once so legacy non-empty lists that
  omitted the in-process agent get it appended before the filter applies.
- **Session id persistence**: router **and** cli `onAgentResolved` use
  `agent-session-bindings.ts` (`bindTurnAgentSession` + persist tables)
  instead of per-agent if-chains. Cursor now has `cursorSessionId`
  like the other resume-driven CLI agents.

The fix direction for remaining name special-cases: push behaviour
into `AgentAdapter` / shared tables — never special-case by name in
the dispatcher. See § 7 anti-patterns.
