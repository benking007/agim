# `mcp__imhub__ask_user` — structured multi-choice agent → user question

Lets the agent present a well-defined choice ("did you mean A or B?")
and reliably get the answer back without the user accidentally treating
the prompt as a new request.

## Why a separate primitive

agim's existing user-facing flows:

- **Y/N approval** (approval-bus + sidecar) — heavy, gated on tool use,
  one binary decision per call.
- **Free-form chat** (the regular agent reply stream) — no structure;
  the agent has to parse natural language and may misinterpret.
- **`/remind` confirmation card** — domain-specific to reminders.

What was missing: a *structured* way for the agent to ask N choices
("which of these emails do you want me to draft a reply to?") and get
a typed answer back deterministically. That's `ask_user`.

## How the agent calls it

Once the MCP sidecar is bundled with the agent (Claude Code / Codex /
OpenCode), the tool appears as `mcp__imhub__ask_user` with the schema:

```ts
{
  question: string                   // 1-1000 chars
  choices: string[]                  // 2-9 entries, each ≤80 chars
  timeoutSec?: number                // 5-1800, default 300
  allowTextReply?: boolean           // default true; false = button-only
}
```

Example agent call:

```json
{
  "tool": "mcp__imhub__ask_user",
  "input": {
    "question": "你说的张三是哪一位？",
    "choices": ["张三 A · @aaa（同事）", "张三 B · @bbb（朋友）", "都不是，新人"],
    "timeoutSec": 120
  }
}
```

Successful result:

```json
{
  "ok": true,
  "result": {
    "index": 2,
    "label": "张三 B · @bbb（朋友）",
    "via": "button",
    "raw": "ask:abc-123:2"
  }
}
```

Failure result:

```json
{ "ok": false, "error": "user did not respond within 120s", "reason": "timeout" }
```

Failure reasons:

| `reason` | meaning |
|---|---|
| `timeout` | user didn't respond before `timeoutSec` |
| `cancelled` | system shutdown / explicit cancel (test/admin) |
| `invalid` | malformed input (empty question, bad choices, unknown runId) |
| `no-messenger` | the platform isn't registered (rare; misconfigured ACP caller) |

## Per-platform UX

| platform | rendering | resolution |
|---|---|---|
| Telegram | inline-button card | button tap (instant); or numeric / letter / label text reply |
| Feishu | choice card (when adapter supports buttons; falls back to text) | button tap; or numeric / letter / label text reply |
| Discord | inline-button card (when adapter supports it) | button tap; or numeric / letter / label text reply |
| DingTalk | numbered text message | numeric / letter / label text reply |
| WeChat (iLink) | numbered text message | numeric / letter / label text reply |
| Web chat | choice card or text (depending on UI) | button click or text |

Text matching is forgiving:

1. **Numeric**: `"1"`, `"2"` → matches that 1-indexed choice
2. **Letter**: `"a"`, `"b"`, `"c"` → matches that letter-indexed choice
3. **Exact label** (case-insensitive)
4. **Substring**: `"go ahead and approve"` matches a choice labelled
   `"Approve"`. Longest label wins on ambiguity so "approve in bulk"
   wins over "approve".

Non-matching text passes through to the normal agent router; the user
changed topic and the ask either times out on its own or the agent
asks again.

## Architecture

```
                  agent (CLI: Claude / Codex / OpenCode)
                            │
                  mcp__imhub__ask_user tool call
                            │
                  MCP sidecar (claude-code/mcp-approval-server.ts)
                            │  JSON-RPC over Unix socket
                            ▼
                  approval-bus.handleAsk
                            │
                  ask-user-rpc.handleAskOp
                            │
       ┌────────────────────┼─────────────────────┐
       │                    │                     │
       ▼                    ▼                     ▼
  resolve via         resolve via             timeout
  inbound text       inline button         (default 300s)
  intercept           callback
       │                    │                     │
       └─────────► AskResult to sidecar ◄─────────┘
                            │
                            ▼
                  agent receives the choice
                  and continues its loop
```

Flow control:

- `handleAskOp` registers a pending entry keyed by `reqId` and returns
  a Promise that resolves on the first of: text match / button tap /
  timer fire.
- `ask-user-router.tryHandleAskReply` is called from `cli.ts onMessage`
  BEFORE the normal agent router. If it matches, it consumes the
  message and stops.
- `ask-user-router.bindButtonHandlerForPlatform` registers
  `onButtonCallback` per messenger; the callback parses
  `ask:<reqId>:<index>` data and resolves the pending.

The pending Map is in-memory only — agim restarts during an in-flight
ask resolve the agent with `error: 'approval bus disconnected',
reason: 'cancelled'` (the bus drains all pending on disconnect).

## Guardrails

- **Choices**: 2–9 entries (keypad-friendly), each ≤80 chars.
- **Question**: 1–1000 chars (longer prompts get rejected so the IM
  bubble stays manageable).
- **Timeout**: 5–1800 seconds (default 300 = 5 min). Long enough for
  the user to read carefully; short enough that a forgotten ask
  doesn't sit forever.
- **Per-runId scoping**: like `mcp__imhub__push_message`, the question
  is delivered to the caller's OWN IM thread. No cross-user / cross-
  thread spoofing — the runId-to-RunContext resolution enforces it.

## Best practices for agents

- Use `ask_user` for **structured choices** — disambiguation, confirm-
  then-proceed, picking one of N known options.
- DON'T use it for **free-form questions** (just ask in chat).
- DON'T use it for **Y/N permission gates** (those go through the
  regular tool-use approval flow).
- DON'T **poll** (call once + wait, don't loop).
- Keep `question` concise — the user is reading it in IM, not on a
  dashboard. Aim for ≤200 chars.
- Order `choices` from most-likely to least-likely so the keypad-
  friendly indices feel natural.

## Telemetry

Every ask is logged at info level by `ask-user-rpc`:

```
{event:'ask.opened',    reqId, platform, threadId, choices, timeoutSec, cardSent}
{event:'ask.resolved.text',   reqId, choice}
{event:'ask.resolved.button', reqId, choice}
```

`listPendingAsks()` returns an array of in-flight asks (reqId,
platform, threadId, question preview, choice count, age in ms) for
future `/tasks#ask` web UI tiles.
