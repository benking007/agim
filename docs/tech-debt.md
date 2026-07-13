# Technical debt inventory

Living list of leftover debt. See also [`naming.md`](./naming.md).

## Done recently

| Item | Action |
|------|--------|
| SPA Native Agent Save silently dropping policy/heartbeat keys | Allowlist + SPA PUT key pin |
| Misclassified critic / semantic-stuck / compaction envs | Reclassified + allowlisted |
| `auto-compact.ts`, `SUBTASK_AGENT_SESSION`, `runAgentLoop` barrel | Removed |
| Stale `web-token` / `AGIM_WEB_V2` docs | Corrected |
| Display name `native` → lowercase `agim` | Now **Agim Agent** |
| Directories `native/` / `pi-native/` | Renamed → `agim-agent-shared/` / `agim-agent/` |
| `AGIM_TIMEOUT_DEFAULT` meaning | Canonical `AGIM_APPROVAL_ON_TIMEOUT` (+ legacy read) |
| Dual plan-mode kill switches | Canonical `AGIM_PLAN_MODE=on\|off\|disabled` (+ legacy) |
| SPA nav “Workspace” vs Access Rules | Nav → **Agent Files** / **Agent 文件** |

## Intentionally keep (ops / compat)

| Item | Why |
|------|-----|
| Registry id `native` | Config/session/cron wired; aliases cover chat |
| `AGIM_NATIVE_*` env prefix | Historical; future `AGIM_AGENT_*` aliases deferred |
| Tool names `native_*` | Prompt/policy break risk |
| `AGIM_ENABLE_GLOBAL_IM` / `AGIM_ENABLE_REMOTE_AGENT` | Compliance gates |
| `config.agents: []` = allow-all | Back-compat |
| Session legacy single-file JSON | Back-compat loader |
| `/setup`, `/schedule`, `?token=` | Soft deprecation |
| `autonomous-loops` skill shim | Until advertised v1.8 window |

## Follow-up (high break cost — deferred)

| Item | Notes |
|------|-------|
| Registry `native` → `agim` | Needs config + session migration |
| Tools `native_*` → `agim_*` | Prompt + deny-list migration |
| `pi-sessions` → `agim-sessions` | On-disk migration |
| Config `workspaces[]` → `tenants[]` | API + SPA |
| Shrink `agent-loop.ts` | Extract shared helpers; delete retired loop body |

## Dead env knobs (must stay off SPA allowlist)

- `AGIM_NATIVE_BLANK_RETRY_MAX`
- `AGIM_NATIVE_LENGTH_RECOVERY_MAX`
- `AGIM_NATIVE_COMPACT_*` (not `AGIM_NATIVE_COMPACTION`)
- `AGIM_NATIVE_STREAM_PARTIAL`
- `AGIM_NATIVE_FIRSTTOKEN_RETRY_*`

Pinned by `test/unit/admin-env-allowed-keys.test.ts`.
