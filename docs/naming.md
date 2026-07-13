# Naming glossary

Canonical names for Agim surfaces. When code, config, UI, and docs
disagree, **this file wins** for new work. Historical keys stay as
aliases until a migration is explicitly scheduled.

## Identity matrix

| Layer | Canonical | Also accepted | Do not invent |
|-------|-----------|---------------|---------------|
| Brand | **Agim** / 阿吉姆 | — | “Agim CLI product” as a separate brand |
| npm package | `agim-cli` | — | renaming without a major release |
| Binary / state dir | `agim`, `~/.agim/` | — | — |
| Built-in agent (UI / chat) | **Agim Agent** | slash `/agim`, `/na`, `/llm` | calling it “PI” in operator docs |
| Built-in agent (config / registry) | `native` | aliases above | changing registry id without migration |
| Built-in agent (code dir) | `src/plugins/agents/agim-agent/` | was `pi-native/` | treating `pi` CLI as the same thing |
| Shared prompt/policy helpers | `src/plugins/agents/agim-agent-shared/` | was `native/` | assuming this folder is the adapter |
| External PI CLI agent | registry `pi` | `/pi`, `/pi-agent` | “pi-native” |

Display rule: show **Agim Agent** to humans; persist **`native`** in
`config.json` / sessions / jobs until a dedicated migration renames it.

## Protocols (do not collapse)

| Name | Meaning | Typical knobs |
|------|---------|---------------|
| **ACP** | Remote agents plugged **into** Agim (`acpAgents[]`, discovery) | `acpPort`, `AGIM_ENABLE_REMOTE_AGENT` |
| **A2A** | Agents calling each other **inside** Agim (`call_agent`) | `AGIM_A2A_*` |
| **Agim ACP endpoint** | Agim speaking ACP **outward** on `:9090` | `~/.agim` access-token / legacy `acp-token` |

UI copy should say the full phrase (“Remote agents (ACP)”, “Agent
handoffs (A2A)”), not bare “ACP” alone.

## Workspace (two different words)

| Surface | Meaning | Route / field |
|---------|---------|---------------|
| **Agent files** | Per-agent CWD browser (AGENTS.md, memory files, …) | SPA `/workspace`, API `/api/workspace-files` |
| **Access rules** | Multi-tenant member / agent / rate-limit scopes | SPA `/settings/workspaces`, config `workspaces[]` |

Never use the bare word “workspace” in new UI strings without the
qualifier (files vs access rules).

## Env families (ops)

| Concern | Canonical env | Legacy alias (still read) |
|---------|---------------|---------------------------|
| Approval timeout policy (`allow` \| `deny`) | `AGIM_APPROVAL_ON_TIMEOUT` | `AGIM_TIMEOUT_DEFAULT` |
| Plan mode process default | `AGIM_PLAN_MODE` = `on` \| `off` \| `disabled` | `AGIM_NATIVE_PLAN_MODE` (truthy → on), `AGIM_DISABLE_PLAN_MODE=1` (→ disabled) |
| Agim Agent behavioral knobs | `AGIM_NATIVE_*` (historical prefix) | Future: `AGIM_AGENT_*` with aliases — not renamed in this pass |

Boolean truthiness still varies by family (`on`/`off`, `1`/`0`). New knobs
should prefer `on`/`off` and document the default explicitly.

## Jobs vocabulary

| Term | Meaning |
|------|---------|
| **Jobs** (`/tasks/jobs`) | Agim `job-board` rows (inline IM turns, async tasks) |
| **Background jobs** (`/tasks/bgjobs`) | Host CLI agent background scripts (Claude/opencode/codex) |
| **A2A / inline job** | Nested `call_agent` tracking row under a parent job |

## Deliberately deferred (high break cost)

Tracked in [`tech-debt.md`](./tech-debt.md):

1. Registry id `native` → `agim` (config / session / cron migration)
2. Tool names `native_*` → `agim_*` (prompt + policy migration)
3. Session dir `pi-sessions` → `agim-sessions`
4. Config field `workspaces[]` → `tenants[]`
