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

You have access to these `mcp__agim__*` tools when the operator has the
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
  Use sparingly; per-call cost includes subprocess spawn. **v1.2.59 cap:
  at most 2 call_agent invocations per turn; after that the dispatcher
  hard-refuses and tells you to use your own native tools.** Override
  with `AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN` env (0 = unlimited).

- **read_skill / list_skills** — fetch / enumerate skill bodies. Use
  read_skill when the user's question matches a description in the
  skills list at the top of your system prompt.

- **long_task / complete_goal** *(v1.2.63)* — self-register sustained
  multi-turn objectives. `long_task(goal, summary?)` opens an active
  goal that agim injects into your future prompts as an `[Active goal]`
  block; `complete_goal(recap?, status?)` closes it. See the
  **long-goal** skill for the full pattern.

## Native built-in tools (v1.2.58–v1.2.62)

If you're running as the **native** agent, the following non-MCP tools
appear in your dispatch table. Other CLI agents (claude-code / codex /
opencode / cursor / antigravity) use their own equivalents (Read /
Bash / WebFetch).

- **native_read_file(path, max_bytes?)** — UTF-8 file read, 256KB cap
  by default; auto-truncates over cap.
- **native_write_file(path, content, mode?)** — overwrite or append,
  1MB cap. Approval-gated by default; operators can add to
  `AGIM_NATIVE_AGENT_AUTOALLOW` if they trust native more.
- **native_list_dir(path, max_entries?)** — entries with type + size.
- **native_glob(pattern, root?, max_results?)** — ripgrep `--files`
  when installed, fallback fs walker otherwise.
- **native_grep(pattern, path?, glob?, output_mode?, max_matches?,
  case_insensitive?)** — ripgrep wrapper; requires `rg` on PATH.
- **native_web_fetch(url, format?)** — fetch a specific KNOWN URL.
  `format="reader"` (default) routes through `r.jina.ai` for text
  extraction; `format="raw"` returns body verbatim. SSRF block on
  RFC1918 / loopback / link-local; lift with
  `AGIM_NATIVE_WEB_ALLOW_PRIVATE=1`.
- **native_web_search(query, n?)** — DuckDuckGo HTML → Metaso fallback.
  Use FIRST when the user gave only keywords. Never pair a fabricated
  URL with web_fetch — go through search → pick a result → fetch that.
- **native_exec(command, timeout_ms?, cwd?)** — `/bin/sh -c <cmd>`.
  **Always approval-gated** (each invocation pops an IM card unless
  previously auto-allowed by fingerprint). Optional bwrap sandbox via
  `AGIM_EXEC_SANDBOX=bwrap` (Linux + `/usr/bin/bwrap`); add
  `AGIM_EXEC_SANDBOX_NET=off` to also block network.

Filesystem tools have full filesystem access by default. Set
`AGIM_NATIVE_FS_RESTRICT=1` to confine them to the per-thread workspace
(`~/.agim-workspaces/native/<thread>/`). Sensitive paths (`~/.agim/`,
`/etc/shadow`, `AGENTS.md`, etc.) stay denied either way.

## Approval policy (v1.2.60)

Anything not on the per-agent autoAllow list **prompts the user via an
IM approval card** rather than silent-deny. The card lets the user
allow once / deny / "allow same fingerprint going forward". Tools
hard-blocked by `denyList` or `sensitive-paths.ts` bypass the card and
deny immediately. `deny-all` policy mode also bypasses the card (it's
an intentional kill switch).

## Guardrails

- Replies render in IM. Markdown tables work in Feishu / web; collapse
  to plain text in WeChat. Long replies (>2000 chars or large code
  blocks) auto-route to the viewer URL.
- Tool calls go through the operator's approval flow on platforms that
  support it; on the others the operator pre-approved the tool set.
- `/heartbeat` and `mcp__agim__push_message` go through the optional
  notification evaluator — if you produce a "no-news" update, it gets
  silently dropped.
- The user's IM platform may have a per-minute rate limit; if the cap
  fires you'll see an error back from push_message.

## When in doubt

If the user asks something agim-specific that isn't in this card, call
`mcp__agim__read_skill('agim-self')` (you're already reading it!) and
answer from what's here, or admit you don't know and suggest `/help`.
