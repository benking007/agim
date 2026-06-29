---
name: agim-reminders
description: Set / list / cancel / snooze reminders via agim's `mcp__agim__*_reminder` tools. Use whenever the user mentions a future commitment ("明天要开会", "下周一交报告"), asks for a recurring nudge ("每天9点提醒我吃药"), or asks "我有哪些提醒". This replaces nanobot's `cron` skill — agim has its own scheduler.
always: false
---

# Reminders

agim exposes four MCP tools (`mcp__agim__create_reminder`, `list_reminders`, `cancel_reminder`, `snooze_reminder`). Use them PROACTIVELY — don't wait for "提醒我…"; if the user mentions a future event, offer to set one.

## create_reminder

| Field | Type | Notes |
|---|---|---|
| `fireAt` | ISO 8601 local time, e.g. `"2026-05-26T12:00:00"` | First fire time. Compute from current time + user's stated offset. |
| `text` | ≤ 60 chars | Just the activity ("团队聚餐"), NOT the time. |
| `recurrence` | optional | `"every:5m"` · `"daily:08:00"` · `"weekly:1,3,5:09:00"` (Mon/Wed/Fri at 9:00) |
| `promptMode` | optional, default `"llm"` | `"literal"` for verbatim; `"llm"` lets agim's LLM polish text at fire time |

After creating, reply terse:
> ✅ 已设：明天 12:00 团队聚餐

## list_reminders

No args. Returns pending list. Use before suggesting cancel or snooze.

## cancel_reminder

`id` from `list_reminders`. For recurring, this terminates the whole loop.

## snooze_reminder

`id` + `duration` (`"5m"` / `"30m"` / `"2h"`). Creates a new reminder, cancels the original.

## Examples

User: "明天中午吃完饭提醒我去交报告"
→ `create_reminder({ fireAt: "2026-05-26T13:30:00", text: "交报告" })`

User: "每天早上 8 点告诉我天气"
→ `create_reminder({ fireAt: "2026-05-26T08:00:00", text: "查天气", recurrence: "daily:08:00", promptMode: "llm" })`
→ at fire time, agim's LLM polish lets you actually call the `weather` skill instead of repeating "查天气".

User: "把昨天那个 30 分钟一次的取消了"
→ `list_reminders()` → find the row → `cancel_reminder({ id: N })`

## When NOT to use

- **One-off "X 分钟后做 Y"**: yes, use this.
- **Recurring task agim should execute, not just remind**: use `recurrence` + `promptMode: "llm"` and write the text as a task ("查 BTC 价格然后告诉我"). At each fire, agim wakes you up with that prompt.
- **Sustained multi-turn objective**: not a reminder. Use `/goal set` (see the `long-goal` skill).
- **One-shot at exact time + nothing else**: still a reminder.

## Constraints

- High-frequency (interval < 1h) recurring with `promptMode: "llm"` auto-confirms via card. Keep your reply terse — the user already sees the card.
- The `_im_context` field is injected by agim; don't try to set it yourself.
