# Naming glossary

Canonical names for Agim surfaces. When code, config, UI, and docs
disagree, **this file wins** for new work. Historical keys stay as
aliases until the migration window closes — see
[`migration-naming-v2.md`](./migration-naming-v2.md).

## Identity matrix

| Layer | Canonical | Also accepted | Do not invent |
|-------|-----------|---------------|---------------|
| Brand | **Agim** / 阿吉姆 | — | “Agim CLI product” as a separate brand |
| npm package | `agim-cli` | — | renaming without a major release |
| Binary / state dir | `agim`, `~/.agim/` | — | — |
| Built-in agent (UI / chat) | **Agim Agent** | slash `/agim`, `/na`, `/llm`, `/native` | calling it “PI” in operator docs |
| Built-in agent (config / registry) | `agim` | `native` (legacy alias) | new third id for the same agent |
| Built-in agent (code dir) | `src/plugins/agents/agim-agent/` | was `pi-native/` | treating `pi` CLI as the same thing |
| Shared prompt/policy helpers | `src/plugins/agents/agim-agent-shared/` | was `native/` | assuming this folder is the adapter |
| Built-in tools (advertised) | `agim_*` | `native_*` (dispatch alias) | inventing a third prefix |
| Agim Agent session root | `~/.agim/agim-sessions/` | `pi-sessions/` (boot-migrated) | confusing with PI CLI `.pi-sessions` |
| Access-rule config field | `tenants[]` | `workspaces[]` (read + dual-write) | using bare “workspace” for both concepts |
| External PI CLI agent | registry `pi` | `/pi`, `/pi-agent` | “pi-native” |

Display rule: show **Agim Agent** to humans; persist **`agim`** in
`config.json` / new sessions / jobs. Boot migrates legacy `native`.

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
| **Access rules** | Multi-tenant member / agent / rate-limit scopes | SPA `/settings/workspaces`, config `tenants[]` (alias `workspaces[]`) |

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

## Naming v2 (shipped)

Operator guide: [`migration-naming-v2.md`](./migration-naming-v2.md).

| Item | Status |
|------|--------|
| Registry id `native` → `agim` | Done (alias kept) |
| Tools `native_*` → `agim_*` | Done (dispatch accepts both) |
| Session dir `pi-sessions` → `agim-sessions` | Done (boot rename) |
| Config `workspaces[]` → `tenants[]` | Done (read both; dual-write) |
