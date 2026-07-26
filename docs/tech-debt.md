# Technical debt inventory

Living list of leftover debt. See also [`naming.md`](./naming.md).

## Done recently

| Item | Action |
|------|--------|
| Default `AGIM_AUTO_APPROVE` off + open-IM suppress | CR 2026-07-21 P0b → security harden (#218/#219) |
| Persist WS `threadOwners` across restart | CR 2026-07-21 P1b → `web-thread-owners.ts` |
| Shrink `agent-loop.ts` god file | Split to `agent-loop-{types,config,stream,stuck,helpers,run}` + thin facade |
| Decompose `server.ts` / `cli.ts` / approval / Portal | Domain modules + `check:file-budget` |
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
| LLM/MCP URL SSRF guard | CR P1a → `assertSafeUrl` on add; hatch `AGIM_URL_ALLOW_PRIVATE=1` (#220) |
| MCP GET redact auth headers | CR P2a → list masks Authorization / api-key (#220) |
| Atomic `tokens.json` writes | CR P2b → tmp+rename like `llm-secrets.json` (#220) |
| Mobile QR short-TTL exchange | CR P2c → `?c=` + `POST /api/auth/exchange-mobile` (#220) |
| SPA consume `GET /api/llm/presets` | CR M1 → `useLlmPresets` + fallback + drift test (#220) |
| Atomic LLM group delete | CR M2 → `DELETE /api/llm/backends?label=` / `?names=` (#220) |

## Intentionally keep (ops / compat)

| Item | Why |
|------|-----|
| Alias id `native` | One-release routing / config read compat |
| `AGIM_NATIVE_*` env prefix | Historical; future `AGIM_AGENT_*` aliases deferred |
| Dispatch accept `native_*` | Prompt/policy migration window |
| Config read `workspaces[]` + API `/api/workspaces` | SPA URL churn deferred |
| `AGIM_ENABLE_GLOBAL_IM` | Compliance gate |
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
| Further peel `approval-bus.ts` (~1070, still thick facade) | Pending lifecycle / policy pipeline / socket RPC |
| Soft file-budget offenders (>800 lines) | Peel when touching; adapters OK |
| Full activity-lease before hard-delete | Quarantine uses sessionLocks wait; richer lease is milestone B |
| Agim Agent metadata index | After retention stable (milestone H) |
| Unify TUI `/new` id with sessionManager | TUI still mints independent ids |
| Default FS non-restrict product stance | CR 2026-07-21 P1c — keep opt-in `AGIM_NATIVE_FS_RESTRICT` |
| LLM/MCP fetch `redirect: 'manual'` + re-validate | Runtime fetch hardening beyond config-time guard |
| i18n hard-coded secret/role labels | CR L1 |

## Docs debt (living)

| Item | Notes |
|------|-------|
| Keep `agents.md` as sole agent inventory | Architecture docs link out; don't fork tables |
| Archive lives under `docs/archive/` | Index: `docs/archive/README.md`; don't leave one-shots in living sections |
| Web Chat restore documented | `session-model.md` §十 |
| Historical CR stubs | Under `docs/archive/`; living backlog only in tech-debt + latest closed CR |

When adding a one-shot analysis or greyscale note: **move into `docs/archive/` + update `docs/archive/README.md`**, do not leave it under living sections.

## Dead env knobs (must stay off SPA allowlist)

- `AGIM_NATIVE_BLANK_RETRY_MAX`
- `AGIM_NATIVE_LENGTH_RECOVERY_MAX`
- `AGIM_NATIVE_COMPACT_*` (not `AGIM_NATIVE_COMPACTION`)
- `AGIM_NATIVE_STREAM_PARTIAL`
- `AGIM_NATIVE_FIRSTTOKEN_RETRY_*`

Pinned by `test/unit/admin-env-allowed-keys.test.ts`.
