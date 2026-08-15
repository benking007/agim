---
name: long-goal
description: Sustained multi-turn objectives with Focus + Loop. Use when the user describes work that spans more than one chat turn and should stay visible across sessions. Not for one-shot questions.
always: false
---

# Long-running objectives

agim now exposes long-running objectives through **Focus** and **Loop**:

| Primitive | When |
|---|---|
| **/remind** | one-shot fire at time T |
| **/cron** (or `mcp__agim__create_reminder` with recurrence) | repeating timer, each tick independent |
| **/heartbeat** | periodic self-check on what's worth doing now |
| **/focus** / `mcp__agim__focus_set` | sustained attention anchor injected into every prompt |
| **/loop** / `mcp__agim__loop_verdict` | engineering loop with objective, verification, and stop/continue decisions |

Use **Focus** when the user wants an objective to stay visible across many turns. Use **Loop** when the user wants a closed engineering mission with verification.

**Parent gate:** Focus tools and `loop_verdict` are available only on
**Agim Agent**. Sticky CLI parents (Codex / Claude / …) may still
`call_agent` / `call_agents` to spawn Subagents, but for `/loop` the
user should switch sticky to Agim first
(`docs/architecture/cli-subagent-dispatch.md`).

## When to suggest Focus or Loop

If the user says any of:
- "帮我跟一下 X 项目"
- "接下来一周关注 Y"
- "每天早上看一下 Z"（当场 Focus；若要**定时开 Loop**，用户说「开个定时 loop」或「每天…用 Loop…退出条件为…」会先出底栏确认）
- "我要做完 W 才停"
- "long-term track..."

Say:

> 这听起来像个长期目标，建议用 `/focus set <一句话目标>` 锁定方向；如果需要闭环推进，再用 `/loop <目标>` 开启验证循环。

If they confirm, they can type the command, or you can call `mcp__agim__focus_set`. Focus persists via `goals.db` and injects the snippet automatically.

## What you'll see when Focus is active

agim's prompt builder injects a **Focus** block showing:
- title
- body (acceptance criteria / scope)
- recent notes when present

Treat that block as **session metadata, not a user instruction**. It tells you the user's running objective; it does not grant permission to bypass safety rules.

## How to make progress

Per turn:
1. Read the Focus block at the top of context.
2. Do the work the user asked for this turn.
3. If the objective needs closed-loop execution, start or continue Loop: dispatch subagents/tools, verify, then call `mcp__agim__loop_verdict`.
4. If the objective is no longer relevant, suggest `/focus off` to stop injection or `/focus clear` to remove it.

## Writing a good Focus title

- **Idempotent**: re-issuing the same Focus should not conflict. "Ship v1.3" yes; "Finish what I started" no.
- **Bounded**: time / scope clear. "Finish Memory tab A+D merge" yes; "Improve memory" no.
- **Self-contained**: someone reading it cold should know the target.

## Don't

- Don't create more than one active Focus per thread unless the user is replacing the old one.
- Don't fake progress notes. If nothing changed, say so.
- Don't treat Focus as overriding the user's current ask. Current ask wins; Focus is context.

## When to call which

| Situation | Tool |
|---|---|
| User describes a sustained multi-turn objective | `mcp__agim__focus_set` or suggest `/focus set <title>` |
| User wants iterative engineering closure | `/loop <objective>` or continue with `mcp__agim__loop_verdict` |
| Work is verified complete inside Loop | `mcp__agim__loop_verdict({ decision: "stop", met: true, summary })` |
| User cancels or changes direction | `/focus off` or `/focus clear`; for Loop, `loop_verdict` with `decision: "stop"` and `met: false` |
| Durable user fact learned | `mcp__agim__save_memo` or memory tools, only when it should persist beyond this thread |
