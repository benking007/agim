# Architecture: bridge agents + Agim Agent are peers

> Why does agim have both a "bridge" mode and an "Agim Agent"? Are they
> two separate products?

**No.** agim is, and continues to be, a **messenger-to-agent bridge**.
The Agim Agent (internal id: `native`) is just another `AgentAdapter` in the registry —
peer-equal to `claude-code`, `codex`, `copilot`, `opencode`, `kimi-code`, `qoder`, `pi`, `mimo`, and `antigravity`.
The only thing that's "special" about it is **where it runs**
(in-process LLM loop, no subprocess spawn).

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

The current registry:

| name | aliases | kind | implementation |
|---|---|---|---|
| `claude-code` | `/cc`, `/claude`, `/claudecode` | `cli` | `claude-code` CLI subprocess + JSONL stdio |
| `codex` | `/cx`, `/openai`, `/codexcli` | `cli` | `codex exec` subprocess |
| `copilot` | `/co`, `/gh-copilot`, `/github-copilot` | `cli` | GitHub Copilot CLI (`copilot -p --output-format json`) |
| `opencode` | `/oc`, `/opencodeai` | `cli` | opencode CLI (stdio or HTTP daemon) |
| `kimi-code` | `/kimi`, `/km` | `cli` | Kimi Code CLI (`kimi -p --output-format stream-json`) |
| `qoder` | `/qd`, `/qodercli` | `cli` | Qoder CLI (`qodercli --print --output-format stream-json`) |
| `pi` | `/pi`, `/pi-agent` | `cli` | PI CLI (`pi --mode json -p`) |
| `mimo` | `/mo`, `/mimo-code` | `cli` | MiMo Code CLI (`mimo run --format json`) |
| `antigravity` | `/agy`, `/gemini`, `/ag` | `cli` | Google Antigravity CLI |
| `native` | `/agim`, `/na`, `/llm`, `/native-llm` | `in-process` | LLM client + agent loop (no subprocess) |
| (per-config) | per-config | `remote` | ACP endpoint over HTTP |

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

Because native is just another `AgentAdapter`, every agim feature
works without per-feature wiring. Concretely:

### 5a. Routing

The same `resolveActiveAgent` picks among them. `defaultAgent: 'native'`
is a valid config. `/cc`, `/cx`, `/oc`, `/agim` all switch sticky session.

### 5b. A2A (cross-agent calls)

`mcp__agim__call_agent('native', '...')` works. So does
`mcp__agim__call_agent('claude-code', '...')` from inside native.
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

### 5d. Web admin panels (Stage 6 + P1 follow-up)

Cross-thread admin views land under two SPA areas:

**`/tasks/*`** — runtime queue inspection:
- `/tasks/heartbeat` — every `/heartbeat bind` across threads with
  last-tick status + enable/disable. REST `/api/heartbeat/bindings`.
- `/tasks/goals` — every active goal across threads with lifecycle
  controls (pause / complete / cancel). REST `/api/goals`.
- `/tasks/asks` — live pending `mcp__agim__ask_user` queue with
  per-row Cancel (5s auto-refresh). REST `/api/asks/pending`.

**`/settings/*`** — configuration:

- `/settings/llm` — list / add / remove LLM backends; optional role
  bindings (`cheap` / `evaluator` / `native-chat`); per-backend **Ping**
  button via `/api/llm/backends/:name/ping`.
- `/chat` + `/m/chat` — when switching to `native` without a usable
  backend, show a persistent setup modal (instead of transient toast),
  submit backend config in place, then auto-retry switch.
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
| Disambiguation question from agent to user | `mcp__agim__ask_user` |

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
- **More native models** — add a provider in `src/core/llm/`; native can
  pick it automatically once it has a usable key. `llmRoles` remains an
  optional preference layer for deterministic role routing.
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

## 10. v1.2.145 — native harness upgrade + honest deviations

A round of "harness engineering" (distilled from
[agentic-harness-patterns](https://github.com/keli-wen/agentic-harness-patterns-skill))
hardened the native adapter **without** breaking the peer model. None of
these added a `kind`-based branch in router / approval / audit.

### 10.1 What changed in native

| Area | Change | Where |
|---|---|---|
| Provider | Anthropic usable as a native backend: pseudo-stream now carries complete `toolCalls` (streaming previously dropped every Anthropic tool call); baseURL strips a trailing `/v1` (the wizard preset's `…/v1` 404'd) | `anthropic-provider.ts`, `provider-base.ts` (`ChatStreamChunk.toolCalls`), `agent-loop.ts` |
| Context budget | `readOperatorRole` memoized by mtime/size; system-prompt skills list capped at `MAX_INJECTED_SKILLS` | `native/index.ts` |
| Tool registry | one `assembleNativeTools()` produces defs + dispatch + a **per-call** concurrency classifier (was 3 hand-kept lists); external MCP partition name-sorted for prompt-cache stability | `native/tool-registry.ts`, `agent-loop.ts` (`parallelSafeClassifier`) |
| Instruction layering | operator role = `<cwd>/AGENTS.md` (project) + `<cwd>/AGENTS.local.md` (local, **wins**); `AGIM_NATIVE_AGENT_ROLE_FILE` still pins one file | `native/index.ts` |
| Verification subagent | prompt SOP: produce a result → spin a **fresh** subagent to verify it with a self-contained brief; synthesize-before-delegate. Prompt-only — uses the existing `call_agent`, no new code path | `native/index.ts` |
| Trust gate | `AGIM_NATIVE_TRUST_WORKSPACE=off` makes native skip all workspace-discovered role files (multi-tenant / A2A prompt-injection defence) | `native/index.ts` (`isWorkspaceTrusted`) |
| Audit traceId | native now uses the inbound turn's `traceId` (plumbed via `AgentSendOpts.traceId`) instead of a self-minted `native-<sid>-<ts>` id, so its audit rows correlate to the originating IM message (ADR-0002) | `types.ts`, `router.ts`, `native/index.ts` |

### 10.2 Honest deviations from the peer model

These use a hardcoded **`agentName === 'native'`** check (not
`adapter.kind`), but they still break peer symmetry unless operators
opt in / accept the documented semantics:

- **A2A in-process fast path** (`agim-dispatcher.ts`,
  `call_agent('native')`): **default OFF**. Unset /
  `AGIM_NATIVE_CALL_AGENT_IN_PROCESS` empty → `callAgentByName` (full
  inline job + `intent:'a2a'` audit). Opt in with `=on` for the
  latency fast path (no A2A job row).
- **`isAgentEnabled('native')` returns true unconditionally**
  (`live-config.ts`): the SPA `config.agents` disable toggle is a
  preference / default-picker signal, **not** a routing kill-switch —
  `/na` stays reachable. Intentional for installs whose enabled list
  predates native; changing it needs a config migration.
- **ACP SSRF**: `assertSafeAcpUrl` now guards Web discover/test,
  discovery `.well-known` + advertised endpoints, and
  `registry.loadACPAgents` before adapter construction. Runtime fetch
  still uses `redirect: 'manual'`. Escape hatch:
  `AGIM_ACP_ALLOW_LOOPBACK=1`.
- **ACP abort/outcome**: `ACPAdapter` forwards `opts.signal` and reports
  exactly-once `onOutcome`. Token `onUsage` awaits ACP wire support.
- **Session id persistence**: router uses
  `agent-session-bindings.ts` tables instead of per-agent if-chains
  (`onAgentSessionId` + `prepareSubtaskAgentCallOptions`).

The fix direction for remaining name special-cases: push behaviour
into `AgentAdapter` / shared tables — never special-case by name in
the dispatcher. See § 7 anti-patterns.
