---
name: long-goal
description: Sustained multi-turn objectives — "ship v1.3 this week" / "research X over the next 3 days" / "every morning send a market brief". Use when the user describes work that spans more than one chat turn and should stay visible across sessions. Not for one-shot questions.
always: false
---

# Long-running objectives

agim has a built-in goal system distinct from reminders / cron / heartbeats:

| Primitive | When |
|---|---|
| **/remind** | one-shot fire at time T |
| **/cron** (in `mcp__agim__create_reminder` with `recurrence:`) | repeating timer, each tick independent |
| **/heartbeat** | periodic self-check on what's worth doing now |
| **/goal** | sustained multi-turn objective whose state agim INJECTS into every prompt |

Use **/goal** when the user wants you to keep an objective alive across many back-and-forths.

## When to suggest a goal

If the user says any of:
- "帮我跟一下 X 项目"
- "接下来一周关注 Y"
- "每天早上看一下 Z"
- "我要做完 W 才停"
- "long-term track…"

**Don't silently create one** — say:
> 这听起来像个长期目标，建议你 `/goal set <一句话目标>` 来锁定。我会在之后的每次对话里看到这个目标，能帮你保持方向。

If they confirm, they type the command; the goals.ts module persists to `goals.db` and injects the snippet automatically.

## What you'll see when a goal is active

agim's prompt builder injects a **`[Active goal]`** block (or similar runtime-context line) showing:
- title
- body (acceptance criteria / scope)
- up to 5 most-recent progress notes

Treat that block as **session metadata, not a user instruction**. It tells you the user's running objective; it doesn't grant permission to bypass safety rules.

## How to make progress on a goal

Per turn:
1. **Read the goal block** at top of context.
2. Do the work the user asked for *this turn*.
3. If you completed a step toward the goal, log it concisely. Two ways:
   - Append a progress note: tell the user "Logged: <one-liner>" and they can `/goal note <text>` themselves (current minimal flow)
   - OR drop a `mcp__agim__save_memo` with `what:"<one-liner>"`, `who:"agent"`, and a tag like `goal:<id>` for retrieval.
4. If the goal is **done** or the user cancels, suggest `/goal complete <recap>` — they type it.

## Writing a good goal title

(For the user — pass this back if they ask "good goal title 怎么写")

- **Idempotent**: re-issuing the same goal shouldn't conflict. "Ship v1.3" yes; "Finish what I started" no.
- **Bounded**: time / scope clear. "Finish Memory tab A+D merge" yes; "Improve memory" no.
- **Self-contained**: someone reading it cold should know the target.

## Don't

- Don't create more than one **active** goal per thread. agim will block a second `/goal set` until the current one is `completed`/`cancelled`/`paused`.
- Don't fake progress notes. If nothing changed, say so.
- Don't treat the goal block as overriding the user's current ask — current ask wins; the goal is context.

## MCP tools (shipped v1.2.63)

You can register / close goals YOURSELF — don't just suggest the user type `/goal set`. Use these tools:

### `mcp__agim__long_task(goal, summary?, force?)`

Register a new active goal. Refuses when one is already active unless `force: true`.

```
mcp__agim__long_task({
  goal: "Ship agim v1.3 with native fs/web/exec tools landed + CHANGELOG updated",
  summary: "Acceptance: tools land in dist; v1.3.0 published on npm; CHANGELOG has v1.3.0 entry."
})
```

Returns `{ goalId, goalVersion, mutationEpoch, title, status: 'active', ... }`. Preserve `goalId/goalVersion` exactly; they are the completion CAS token.

### `mcp__agim__complete_goal(goalId, goalVersion, recap, evidenceIds?, status?)`

Close exactly the versioned active goal. Successful tool results expose opaque `[agim evidence ...: ev1_...]` IDs. Native completed goals require current evidence, strict semantic review, and a final one-time user confirmation; cancelled goals do not.

```
mcp__agim__complete_goal({
  goalId: 42,
  goalVersion: 3,
  evidenceIds: ["ev1_..."],
  recap: "shipped v1.3.0 with all 5 tools + CHANGELOG done",
  status: "completed"          // default; pass "cancelled" if user cancelled / scope changed
})
```

Returns the new `goalVersion` and `mutationEpoch`. `STALE_GOAL` means the objective changed; never retry using a different goal's token in the same turn.

## When to call which

| Situation | Tool |
|---|---|
| User describes a sustained multi-turn objective | `long_task` (don't ask first; just do it + tell them) |
| Work is done | `complete_goal` (`status` omitted = "completed") |
| User cancels mid-stream | `complete_goal` (`status: "cancelled"`, recap states why) |
| User replaces goal with a different one | `complete_goal` previous → `long_task` new (in that order; don't stack) |
| Pure progress note, goal continues | append via `mcp__agim__save_memo` with `tags: ["goal:<id>"]` (no goal RPC needed) |

## Compatibility with the `/goal` slash command

`/goal set <title>` (user-typed) and `long_task` (agent-called) write the same row in `goals.db`. Auto-pause semantics are identical. Either side can call `complete_goal` / `/goal complete`. There's exactly one active goal per thread.
