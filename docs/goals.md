# `/goal` — sustained-objective tracking

> P0 #2 of the nanobot-vs-agim comparison plan. One active goal per IM
> thread; injected into every prompt so the agent stays on-mission across
> many turns.

## Why a separate primitive

agim already has four ways to make the agent do something at a future
point:

| primitive | shape |
|---|---|
| `/remind` | fire ONE text at time T |
| `/cron` | run an agent prompt on a schedule, no state across runs |
| `/heartbeat` | periodic self-check: "anything to do right now?" each tick |
| **`/goal`** | sustained MULTI-turn objective the agent sees every reply |

The first three are about *triggering* work. `/goal` is about
*maintaining context* across many user-driven turns — "ship v1.3.0 this
week" / "research the new MCP spec" / "help me debug this issue over
the next few hours."

## Per-thread, one active

Goals are scoped to an IM thread (`platform + channelId + threadId`).
Each thread has at most ONE active goal at a time. Setting a new goal
auto-pauses the previous one (kept in the table for later resume / audit).

## Slash command

```
/goal                       same as /goal show (or help if none)
/goal help                  usage
/goal set <title…>          create / replace the active goal
/goal body <body…>          add or replace a longer body for the active goal
/goal show [<id>]           print active goal (or specific id)
/goal list                  every goal for this thread (any status)
/goal progress <note…>      append a 'user' progress note
/goal pause                 pause the active goal (kept, not injected)
/goal resume <id>           resume a paused goal (auto-pauses current)
/goal complete              mark active goal completed 🎯
/goal cancel                mark active goal cancelled ✖
/goal all                   admin: every active goal across threads
```

Aliases: `/g`, `/目标`.

## How injection works

`buildGoalSnippet(platform, channelId, threadId)` is called once per
turn inside `router.ts` and prepended to the agent prompt **over the
wire only** — the user's stored session history stays clean (no
duplicate "goal" headers per turn). When no active goal exists, the
helper returns `''` and the snippet is dropped.

Format the agent sees:

```
[agim context — active goal #42 for this thread]
Title: Ship v1.3.0
Body:
include CHANGELOG, version bump, release notes, npm publish
Recent progress:
  - 2026-05-23 10:15 (user) drafted CHANGELOG entries for #59-#65
  - 2026-05-23 11:02 (user) bumped version to 1.3.0-rc.1
Use this goal to keep replies on-mission. Ignore if the user explicitly changes topic.
```

Bounded:

- Body truncated at 800 chars in the snippet (4000 char hard cap in
  the store).
- Most recent 5 progress notes injected (the full log lives in the
  store; `/goal show` lists up to 20).

## Lifecycle states

| status | injected? | how reached |
|---|---|---|
| `active` | yes | `/goal set` or `/goal resume` |
| `paused` | no | auto when a new goal is set; manual via `/goal pause` |
| `completed` | no | `/goal complete` (stamps `closed_at`) |
| `cancelled` | no | `/goal cancel` (stamps `closed_at`) |

Closed states (completed/cancelled) are immutable — `/goal resume`
refuses them. Create a fresh goal with `/goal set` instead.

## Storage

`~/.agim/goals.db` (SQLite), same fail-soft helper pattern as the rest
of agim. Schema:

```sql
CREATE TABLE goals (
  id           INTEGER PRIMARY KEY,
  platform     TEXT, channel_id TEXT, thread_id TEXT, user_id TEXT,
  title        TEXT,
  body         TEXT,
  status       TEXT,     -- active / paused / completed / cancelled
  progress_log TEXT,     -- JSON array of {ts, by, text}
  created_at TEXT, updated_at TEXT, closed_at TEXT
)
```

Override path with `IMHUB_GOALS_DB=/path/to/goals.db`.

## Failure modes

- **DB unavailable** (e.g. better-sqlite3 binding missing on bun in
  CI): every helper returns null / [] / false; `buildGoalSnippet`
  returns ''. The agent loop just doesn't see a goal block, which is
  the correct degraded behaviour.
- **Empty title**: rejected by `setActiveGoal`; the slash command
  surfaces "用法：/goal set <标题>".
- **Body too long**: truncated to 4000 chars; user sees an explicit
  rejection from the slash command before save (5000+ chars never
  silently gets stored partial).

## Combining with other primitives

A heavy work session typically uses several primitives together:

```
/goal set 这周完成 v1.3.0 发布
/goal body
- 写 CHANGELOG
- bump package.json
- npm publish
- send announcement to deepseek.club

/remind 每天9点 提醒我看一下 v1.3.0 进度
/heartbeat bind 检查 npm i agim-cli@latest 能不能跑通
```

Each primitive serves a different lifecycle:

- `/goal` = the mission (one per thread)
- `/remind` = scheduled nudges
- `/heartbeat` = autonomous periodic checks
- `/memo` = scattered facts the agent should remember
