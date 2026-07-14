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
| Registry id `native` → `agim` | Boot migrate + alias; see [`migration-naming-v2.md`](./migration-naming-v2.md) |
| Tools `native_*` → `agim_*` | Advertise `agim_*`; dispatch accepts both |
| `pi-sessions` → `agim-sessions` | Boot rename when target absent |
| Config `workspaces[]` → `tenants[]` | Prefer `tenants`; dual-write on SPA save |
| Agim Agent JSONL orphaned on `/new` / TTL | Quarantine + grace purge (`agim-agent-session-lifecycle`) |

## Intentionally keep (ops / compat)

| Item | Why |
|------|-----|
| Alias id `native` | One-release routing / config read compat |
| `AGIM_NATIVE_*` env prefix | Historical; future `AGIM_AGENT_*` aliases deferred |
| Dispatch accept `native_*` | Prompt/policy migration window |
| Config read `workspaces[]` + API `/api/workspaces` | SPA URL churn deferred |
| `AGIM_ENABLE_GLOBAL_IM` / `AGIM_ENABLE_REMOTE_AGENT` | Compliance gates |
| `config.agents: []` = allow-all | Back-compat |
| Session legacy single-file JSON | Back-compat loader |
| `/setup`, `/schedule`, `?token=` | Soft deprecation |
| `autonomous-loops` skill shim | Until advertised v1.8 window |
| SQLite table `native_todos` | On-disk schema; unrelated to tool rename |

## Follow-up

| Item | Notes |
|------|-------|
| Drop `native` / `native_*` / `workspaces` read aliases | After compat window |
| Rename SPA `/api/workspaces` → `/api/tenants` | Optional; keep redirect |
| Shrink `agent-loop.ts` | Extract shared helpers; delete retired loop body |
| Full activity-lease before hard-delete | Quarantine uses sessionLocks wait; richer lease is milestone B |
| Agim Agent metadata index | After retention stable (milestone H) |
| Unify TUI `/new` id with sessionManager | TUI still mints independent ids |

## Dead env knobs (must stay off SPA allowlist)

- `AGIM_NATIVE_BLANK_RETRY_MAX`
- `AGIM_NATIVE_LENGTH_RECOVERY_MAX`
- `AGIM_NATIVE_COMPACT_*` (not `AGIM_NATIVE_COMPACTION`)
- `AGIM_NATIVE_STREAM_PARTIAL`
- `AGIM_NATIVE_FIRSTTOKEN_RETRY_*`

Pinned by `test/unit/admin-env-allowed-keys.test.ts`.
