# nanobot vs agim — comparison-plan rollout

> Single-page reference for the multi-stage work that landed all
> P0 + P1 + P2 + P3 items from the nanobot vs agim comparison plan.
> Useful when reviewing PRs out of order, picking a starting point
> for a new contributor, or auditing what shipped vs what's deferred.

## TL;DR

agim adopted the most valuable structural features from
`HKUDS/nanobot` **without changing its product identity**:

- agim stays a **messenger ↔ agent bridge** (Claude Code / Codex /
  OpenCode / Antigravity are the main route).
- A new **`native` AgentAdapter** runs an in-process LLM agent loop —
  a **peer backend** alongside the CLI agents (same interface, same
  router, same approval bus, same A2A, same skills, same goal/
  heartbeat/ask_user injection).
- 6 web admin panels + 1 CLI wizard pair (`agim setup llm` / `agim
  setup mcp`) + diagnostic commands (`agim diag llm/mcp`) +
  cross-thread runtime views (`/tasks/heartbeat`, `/tasks/goals`,
  `/tasks/asks`).

See [`docs/architecture-bridge-and-native.md`](architecture-bridge-and-native.md)
for the architectural stance.

## Recommended landing order

The work was split into focused PRs that can land in this order. Each
PR is self-contained and the suite never broke between them.

### Stage 1 — Native LLM foundation
- **PR #59** — `feat(llm): native LLM client (D+ Stage 1) — direct OpenAI-compat backend for internal callers`
  - `src/core/llm/{provider-base,openai-compat-provider,secrets,registry,introspection}.ts`
  - `llmBackends` + `llmRoles` config sections
  - First three callers wired: `memory-distill`, `memory-consolidate`,
    `intent-llm` try native first, fall back to CLI

### P0 items that ride on top of Stage 1
- **PR #60** — `feat(evaluator): notification gate for agent-initiated outbound messages`
  - P0 #9. LLM-graded "should we deliver this push?" filter.
- **PR #61** — `feat(heartbeat): per-thread bindings store + 3-phase scheduler`
  - P0 #1. Proactive wake-up loop with DECIDE → EXECUTE → EVALUATE.

### Stage 2 — Native AgentAdapter (4 sub-PRs)
- **PR #62** — `feat(llm): tool-call types + ChatOptions/ChatResult extensions`
- **PR #63** — `feat(llm): external MCP server attach`
- **PR #64** — `feat(llm): multi-iteration agent loop with approval gate`
- **PR #65** — `feat(agent): native AgentAdapter + registry + onboarding`
  - After #65, `/cc native` works end-to-end.

### Standalone P0 items
- **PR #66** — `feat(goals): /goal sustained-objective tracker (P0 #2)`
- **PR #67** — `feat(ask-user): mcp__imhub__ask_user — structured agent→user choice (P0 #5)`
- **PR #68** — `feat(skills): agim-owned SKILL.md engine with 3-tier disclosure (Stage 3 + P0 #3)`
- **PR #69** — `feat(persona,memory): inline row-age annotations into agent context (P0 #4)`

### Stage 4 — Config UX
- **PR #70** — `feat(stage4): CLI wizard + Web REST API for native LLM backends`
  - `agim setup llm {add,list,remove,role,secret}` + `POST/GET/DELETE
    /api/llm/{backends,roles,secrets}`.

### Stage 5 — A/B evaluator
- **PR #71** — `feat(stage5): /router compare A/B evaluator + tryIntrospectChain fallback helper`

### One-shot consolidation
- **PR #72** — `feat: full nanobot-vs-agim comparison-plan landing (Stage 1-5 + P0 #1-#5 + #9)`
  - Combined branch with every per-stage merge. Use this PR if you
    want one diff to review.

### Stage 6 — Architectural stance + Web admin panels
- **PR #73** — `refactor(architecture): native agent is a peer AgentAdapter`
  - `AgentAdapter.kind` UI tag; `/agents` rendering; `docs/architecture-bridge-and-native.md`.
- **PR #74** — `feat(stage6): Web admin panels for LLM + MCP + Native Agent`
  - `/settings/llm` + `/settings/mcp` + `/settings/native-agent` SPA
    pages. Stage 6 backend (`/api/mcp/*` CRUD + `/api/llm/.../ping`).

### P1 follow-ups
- **PR #75** — `feat(p1): /tasks/{heartbeat,goals,asks} cross-thread admin views`
- **PR #76** — `feat(p1): /settings/agim-skills SKILL.md editor`

### P2 — CLI diag + quick-start
- **PR #77** — `feat(cli): agim diag {llm,mcp} + setup llm native-enable`

### P3 — Symmetry + housekeeping
- **PR #78** — `feat(cli): agim setup mcp wizard — restore LLM/MCP CLI symmetry`
- **PR #79** — `fix(gen-endpoints): add --check mode + drift warning`

## End-state capability matrix

| capability | CLI | Web SPA | IM slash |
|---|---|---|---|
| LLM Backends — list / add / remove | `agim setup llm` | `/settings/llm` | – |
| LLM role bindings | `agim setup llm role` | `/settings/llm` | – |
| LLM secrets | `agim setup llm secret` | `/settings/llm` | – |
| LLM connectivity probe | `agim diag llm` | Ping button on `/settings/llm` | – |
| Native agent quick-enable | `agim setup llm native-enable` | manual 3 steps on `/settings/llm` | – |
| Native agent behaviour knobs | `~/.agim/env` | `/settings/native-agent` | – |
| Notification evaluator settings | `~/.agim/env` | `/settings/native-agent` | – |
| Heartbeat scheduler settings | `~/.agim/env` | `/settings/native-agent` | – |
| MCP Servers — list / add / remove | `agim setup mcp` | `/settings/mcp` | – |
| MCP connectivity probe | `agim diag mcp` + `agim setup mcp health` | Health button on `/settings/mcp` | – |
| agim Skills — list / view | `/skill list / show` | `/settings/agim-skills` | – |
| agim Skills — create / edit | – | `/settings/agim-skills` | – |
| Heartbeat bindings — view / toggle | – | `/tasks/heartbeat` | `/heartbeat bind / show` |
| Goals — cross-thread view + lifecycle | – | `/tasks/goals` | `/goal …` |
| Pending asks — view + cancel | – | `/tasks/asks` | – |
| `/router compare` A/B | – | – | `/router compare` |
| Memory row-age annotation | always-on | always-on | always-on |

CLI / Web parity is intentional for every config surface; for runtime
queue views the Web is the right surface (cross-thread); for per-
thread creation IM is the right surface (the thread context comes
from the user's IM).

## Cumulative test count

After all the PRs above merged:

- **bun**: 1555+ pass / 0 fail / 106 skip across 120+ files
- **vitest** (SPA): 196 pass across 38 files
- **typecheck**: src + test clean
- **biome lint**: 0 errors

(numbers grow per PR; the figure above is the cumulative state at the
final P3 PR in this rollout)

## Anti-patterns (do NOT)

Per [`docs/architecture-bridge-and-native.md`](architecture-bridge-and-native.md) § 7:

- ❌ Don't write `if (adapter.kind === 'in-process') ...` in router /
  approval / A2A / audit code. The whole point is every backend is a
  peer through one interface.
- ❌ Don't make `native` the hardcoded default; respect
  `defaultAgent` like any other backend.
- ❌ Don't write a parallel router / approval bus / audit pipe just
  for native. There's one of each.

## What's deferred to future plans

These appeared in the comparison plan but were judged lower-value or
needed a separate design pass:

- IM-interactive approval cards for native agent tool calls (policy
  mode is sufficient today; IM interactive needs ChoiceCard plumbing
  the way ask_user has)
- Streaming partial responses from native agent to IM (need viewer-
  routing on the IM side first)
- Per-thread skill subscriptions (`/skill enable` / `/skill disable`)
- Skills marketplace (fetch from URL)
- Filesystem watcher for hot-reload (5-min cache TTL + manual refresh
  cover the common case)
- TYPE_MAP comprehensive overhaul in `tools/gen-endpoints.mjs` (PR #79
  added the `--check` guard; the fuller fix is its own PR)

These are operator-grade quality-of-life add-ons rather than blocking
parity items; the comparison plan's value extraction is done.
