# Goal residue after Focus / Loop migration

> Status: 2026-07-26. Goal UI, API, slash aliases, RPC, and MCP tools are retired. Focus and Loop are the product surface.

## Current surface

| Surface | Status |
|---|---|
| `/focus` / `/loop` slash | Active product surface |
| `mcp__agim__focus_*` / `mcp__agim__loop_verdict` | Active tool surface |
| Portal slash and `+` menus | Point to Focus / Loop / Subagent |
| `/help` | Describes Focus / Loop only |

## Retired in this cleanup

| Retired item | Replacement |
|---|---|
| SPA `/tasks/goals` | No admin Goal UI; use Focus in-thread |
| REST `/api/goals*` | No public Goal REST surface |
| `/goal`, `/g`, `/目标` | `/focus` |
| `/long_task`, `/complete_goal` slash shims | `/focus` + `/loop` |
| `mcp__agim__long_task`, `mcp__agim__complete_goal` | `mcp__agim__focus_set` + `mcp__agim__loop_verdict` |
| Sidecar `type: "goal"` RPC and `goal-rpc.ts` | Removed |
| `GoalEvent` SSE payload | Removed with the Goal UI |

## Deliberately retained

| Residue | Reason |
|---|---|
| `src/core/goals.ts` + `goals.db` | Focus storage reuses the existing active/paused rows |
| `src/core/goal-evidence.ts` | Tool ledger still supports Focus/Loop critic and evidence tracking |
| `src/core/llm/goal-critic.ts` | Agent-loop off-track critic integration remains |
| `FactCategory: 'goal'` | Memory semantic category, not the retired `/goal` product surface |

## Non-goals

- Do not rename `goals.db` in this cleanup; a Focus-specific storage migration can happen separately.
- Do not remove memory category `goal`.
- Do not remove `goal-evidence.ts` or `goal-critic.ts` while Loop still consumes them.
