---
name: agim-self
description: Reference card for agim's built-in slash commands and MCP tools. Read this when the user asks about agim itself, reminders, memos, goals, heartbeat, or how to do something with the IM bridge.
always: false
---

# agim self-reference

You are running as an agim agent. The user reached you over an IM
platform (WeChat / Feishu / DingTalk / Telegram / Discord / Web) routed
through agim's bridge. This skill summarises the **agim-side**
capabilities the user might ask you about.

## Slash commands the user can type

| command | purpose |
|---|---|
| `/new` | start a fresh conversation context |
| `/agents` | list available agent backends |
| `/<agent>` | switch agent (`/cc` claude-code, `/oc` opencode, `/cx` codex, `/co` opencode) |
| `/remind <when> <text>` | one-shot or recurring reminder |
| `/memo …` | 5W1H persistent memory (auto-extract via natural language) |
| `/goal set <title>` | sustained multi-turn objective |
| `/heartbeat bind <body>` | periodic agent self-check on this thread |
| `/btw <q>` | bypass current thread for a quick parallel question |
| `/abort` | stop the running agent |
| `/help` | full command list |

## MCP tools you can call

You have access to these `mcp__imhub__*` tools when the operator has the
sidecar wired:

- **save_memo / search_memos / update_memo / delete_memo / request_location_capture**
  — store and retrieve 5W1H facts about the user (preferences, holdings,
  meeting venues, GPS pins). Use when the user mentions something worth
  remembering, or when answering a question that needs context they've
  told you before.

- **create_reminder / list_reminders / cancel_reminder / snooze_reminder**
  — manage reminders. Use when the user says "提醒我 X 时候做 Y" without
  the explicit `/remind` slash.

- **memory_query / memory_save / memory_list / memory_delete** — long-term
  fact store. Different from memo: this is the system's structured memory
  used to inject persona context into every prompt. Save when you learn a
  durable fact (preference / project / role); query when the user asks
  about themselves.

- **push_message** — send a follow-up message to the user's IM thread
  without waiting for them to ask. Use for monitoring alerts or
  long-task progress updates only.

- **ask_user** — present a 2-9 choice question and wait for the user to
  pick one. Use for disambiguation, not free-form questions.

- **call_agent** — hand off to a different agent backend for a sub-task.
  Use sparingly; per-call cost includes subprocess spawn.

- **read_skill** — fetch the full body of one of the skills listed in
  your system prompt. Use when the user's question matches a skill
  description.

## Guardrails

- Replies render in IM. Markdown tables work in Feishu / web; collapse
  to plain text in WeChat. Long replies (>2000 chars or large code
  blocks) auto-route to the viewer URL.
- Tool calls go through the operator's approval flow on platforms that
  support it; on the others the operator pre-approved the tool set.
- `/heartbeat` and `mcp__imhub__push_message` go through the optional
  notification evaluator — if you produce a "no-news" update, it gets
  silently dropped.
- The user's IM platform may have a per-minute rate limit; if the cap
  fires you'll see an error back from push_message.

## When in doubt

If the user asks something agim-specific that isn't in this card, call
`mcp__imhub__read_skill('agim-self')` (you're already reading it!) and
answer from what's here, or admit you don't know and suggest `/help`.
