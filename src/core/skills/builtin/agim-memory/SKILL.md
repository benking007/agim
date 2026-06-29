---
name: agim-memory
description: Persist and query the user's long-term facts via agim's `mcp__agim__memory_*` tools and the 5W1H `*_memo` tools. Use proactively when the user reveals preferences ("我不喝咖啡"), holdings ("我持有 600519"), recurring places ("我家在朝阳"), or facts that should survive past this turn. Also use when answering questions that need facts they've told you before.
always: false
---

# Memory

agim has two related stores. Use whichever fits the shape of the data.

## Layer 1 — Long-term memory (`memory_*`)

Free-form key-value facts, semantic-searchable. Backed by `MEMORY.md` + optional vector index.

| Tool | When |
|---|---|
| `memory_save({ what, type?: "user"|"feedback"|"project"|"reference" })` | Learn anything worth remembering long-term: user role, preferences, ongoing initiatives, useful URLs |
| `memory_query({ query, k=5 })` | Recall — user references something they told you before |
| `memory_list({ type?, limit? })` | Browse what's in memory (rare; usually `query` is better) |
| `memory_delete({ name })` | User asks you to forget something specific |

`type` taxonomy (use this exactly):

- **user** — who they are: role, expertise, communication style, goals. Apply when tailoring future replies.
- **feedback** — corrections + confirmations they gave you. "不要再用表格" / "这种做法对了，下次也这样".
- **project** — facts about ongoing initiatives. Decays fast — re-check before relying on it.
- **reference** — pointers to external resources: dashboards, channels, registries. Stable.

Write descriptive memories. Bad: "user likes go". Good: "10-year Go expertise; new to this repo's React side — frame frontend explanations via backend analogues".

## Layer 2 — Structured 5W1H memos (`save_memo` / `search_memos` / `update_memo` / `delete_memo`)

Use for facts with clear who-what-when-where-why-how shape: holdings, addresses, recurring meetings, GPS pins. Each memo has a typed schema and is searchable.

| Tool | When |
|---|---|
| `save_memo({ what, when?, where?, who?, why?, how?, tags? })` | Fact has temporal / spatial structure |
| `search_memos({ query?, tags?, limit? })` | "我上次和谁约的午饭在哪？" |
| `update_memo({ id, … })` | Correct a memo (user said "不对，那家店在国贸") |
| `delete_memo({ id })` | Remove |
| `request_location_capture()` | Ask the user to send a location pin (telegram / wechat support this) |

## When to save proactively

If during a turn you learn something that…

- Is **specific** (not generic knowledge)
- Will be **referenced later** (preferences, ongoing work, holdings)
- Doesn't fit in the current task's output

…save it BEFORE replying. Don't ask permission for every save — that's noise. Do mention briefly: "记下了：你不喝咖啡 → 以后推荐饮品会避开。"

## When NOT to save

- Code patterns / architecture (read the code)
- Ephemeral state (current conversation)
- Anything already in `CLAUDE.md` / project docs
- Test fixtures / example data

These rules apply even if the user asks to save them — push back gently: "这个其实代码里写得很清楚，要不你以后通过读代码而不是记忆来获取？"

## On recall, verify before quoting

Memories are snapshots of what was true at write time. If a memory says "X holds 600519", but the user just said "我已经清仓了", trust the recent statement and `update_memo` / `memory_save` the new state.

Don't quote a memory as authoritative when current observation contradicts it.
