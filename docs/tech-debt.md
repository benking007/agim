# Technical debt inventory

Living list of leftover debt after the bridge / orphan cleanup pass.
Items marked **done** were removed in the same effort; the rest are
intentional keeps or follow-ups.

## Done in this pass

| Item | Action |
|------|--------|
| SPA Native Agent Save silently dropping policy/heartbeat keys | Added to `ENV_EDITABLE_KEYS`; SPA PUT keys pinned by test |
| `AGIM_NATIVE_CRITIC` / `SEMANTIC_STUCK` mislabeled as dead | Reclassified as live; allowlisted |
| `src/core/llm/auto-compact.ts` | Deleted (pi-native uses `AGIM_NATIVE_COMPACTION` + harness) |
| `SUBTASK_AGENT_SESSION` deprecated alias | Deleted |
| `runAgentLoop` barrel export | Removed from `llm/index.ts` |
| Stale `AGIM_WEB_V2` / `web-token` docs | Comment + `AGENTS.md` corrected |

## Intentionally keep (ops / compat)

| Item | Why |
|------|-----|
| `AGIM_ENABLE_GLOBAL_IM` / `AGIM_ENABLE_REMOTE_AGENT` | Compliance distribution gates — not SPA-editable |
| `AGIM_APPROVAL_DISABLED`, `AGIM_LOG_USER_TEXT`, `AGIM_TRUST_LOOPBACK` | Ops kill-switches / privacy |
| `AGIM_DISABLE_PLAN_MODE` | Emergency plan-mode kill |
| `config.agents: []` = allow-all | Back-compat for pre-toggle installs |
| `nativeAgentToggleMigrated` | One-shot boot migration flag |
| Session legacy single-file JSON (no `.log`) | Back-compat loader |
| `/setup` IM shim, `/schedule` → `/cron` | Soft deprecation for IM users |
| `?token=` web auth fallback | WS / iframe compat; warn once per process |
| `autonomous-loops` skill shim | Kept until the advertised v1.8 window |

## Follow-up (not blocking)

| Item | Notes |
|------|-------|
| Shrink `agent-loop.ts` | Extract `ApprovalGate` + semantic-stuck helpers; delete `runAgentLoop` body + dedicated test files once pi-native parity covers them |
| Rename `plugins/agents/native/` | Prompt/policy helpers for pi-native; name still reads as "the adapter" |
| Expose retention / push rate envs in SPA Security | Or document as SSH-only in deployment.md |
| Remove `?token=` after clients migrate | Prefer Bearer / cookie only |
| Drop `/setup` once IM traffic is gone | Track via command metrics if available |

## Dead env knobs (must stay off SPA allowlist)

These only affected the retired `runAgentLoop` / old auto-compact path:

- `AGIM_NATIVE_BLANK_RETRY_MAX`
- `AGIM_NATIVE_LENGTH_RECOVERY_MAX`
- `AGIM_NATIVE_COMPACT_*` (trigger/keep/summary — not `AGIM_NATIVE_COMPACTION`)
- `AGIM_NATIVE_STREAM_PARTIAL`
- `AGIM_NATIVE_FIRSTTOKEN_RETRY_*`

Pinned by `test/unit/admin-env-allowed-keys.test.ts`.
