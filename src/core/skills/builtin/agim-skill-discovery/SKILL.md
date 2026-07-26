---
name: agim-skill-discovery
description: How to help the user discover / install / update skills from skillhub.cn (agim's curated public skill marketplace) and from this machine's already-installed catalog. Use whenever the user asks "有没有 X skill" / "帮我装 Y" / "查下能做 Z 的 skill" / "更新一下我的 skills" / "what skills do I have".
always: false
---

# Skill discovery

agim's skill catalog is multi-rooted and dynamic. This skill teaches
you how to answer "do I have a skill for X?" and how to install new
ones.

## What's already loaded

The list of currently-available skills is **already injected into your
system prompt** under the heading `agim skills available`. Read it
before assuming you need to search externally. Each line shows
`<name>: <description>`. If the description is empty (`>-`), call
`mcp__agim__read_skill(name)` to fetch the full body.

If the user asks "what skills do I have?", paraphrase the prompt list
back. Don't dump it verbatim — group by domain (finance, white-pig,
ash-* agents, image, etc.) and quote ≤ 15 entries with their one-line
descriptions.

## Looking up details on a known skill

```
mcp__agim__read_skill({ name: "<skill-name>" })
```

Returns the full markdown body (frontmatter stripped). Use when the
user's task matches the description and you need the procedure.

## Searching for new skills (skillhub.cn)

When the user asks for a capability that's NOT in your skill list:

1. **Don't invent one.** Tell the user you don't have a built-in skill
   for X.
2. **Suggest the official source:**

   > skillhub.cn 是 agim 的官方 skill 市场（中文优化）。可以在
   > skillhub.cn 查找合适的 skill slug，再由 operator 决定是否安装。

3. **Or trigger via slash command:**

   - `/skill list` — show installed skills (long output → viewer)
   - `/skill search <keyword>` — agim queries skillhub.cn (if wired)
   - `/skill install <slug>` — install from skillhub (operator-confirmed)
   - `/skill update <slug>` — pull updates (operator-confirmed)

   If these slashes aren't enabled in this build, point the operator at
   **web admin → Settings → agim Skills** to review the locally installed
   catalog. Installing or updating skillhub skills remains an operator
   decision.

## Installation paths (operator-facing)

For operators (not end users) — skills can land in any of:

```
~/.agim/skills/<name>/SKILL.md              ← operator-owned (highest priority)
~/.claude/skills/<name>/SKILL.md            ← shared with terminal Claude
~/.config/opencode/skills/<name>/SKILL.md   ← shared with opencode
~/.codex/skills/<name>/SKILL.md             ← shared with codex
<agim-dist>/core/skills/builtin/<name>/     ← shipped with agim
```

`AGIM_SKILLS_MODE=auto` (default) merges all of them with shadow
priority workspace > builtin. If the operator wants to test a skill in
isolation, `AGIM_SKILLS_MODE=agim-only` restricts to `~/.agim/skills/`.

## Skill restart semantics

The skill loader scans roots **at agim startup** and caches the entry
list. Newly-dropped or edited SKILL.md files **require a service
restart** to appear in the next agent run. Tell the user:

> 安装/修改 skill 后需要「重启服务」才生效——我现在看到的还是上次启动时的快照。

## Building one from scratch

If the user wants to CREATE a new skill (not install one), point them
to the **skill-creator** skill:

```
mcp__agim__read_skill({ name: "skill-creator" })
```

## Don't

- Don't list every skill if the user asked a focused question. Filter
  to relevance first.
- Don't claim a skill exists if it isn't in the system prompt's list.
- Don't try to install skills yourself by writing to filesystem —
  use the slash commands or the web admin. Skill installation is an
  operator decision (skills run with the agent's tool privileges).
