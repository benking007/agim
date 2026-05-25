---
name: skill-creator
description: Create or update agim skills (SKILL.md packages). Use when the user says "新建一个 skill" / "把这个流程做成 skill" / "create a skill for X". Walks through frontmatter, body structure, references/scripts, and where to drop the directory.
always: false
---

# Skill Creator

A skill in agim is a directory shipped under one of these roots (workspace shadows builtin):

```
~/.agim/skills/<name>/SKILL.md          # operator-owned (highest priority)
~/.claude/skills/<name>/SKILL.md         # shared with terminal Claude
~/.config/opencode/skills/<name>/SKILL.md
~/.codex/skills/<name>/SKILL.md
<agim-dist>/core/skills/builtin/<name>/  # packaged with agim
```

`IMHUB_SKILLS_MODE=auto` (default) merges all of them; `agim-only` restricts to `~/.agim/skills/`.

## Core principles (adapted from Anthropic + nanobot)

1. **Be concise.** The summary block (frontmatter `name` + `description`) is injected into **every** turn. Burn that token budget honestly.
2. **Trigger phrases in the description.** Write the description so a model can decide whether to load the body without seeing the body. Phrase as "Use when the user asks …".
3. **Body is read on demand.** Put procedural detail, examples, edge cases, references in the body. The model fetches it via `mcp__imhub__read_skill("<name>")` only when the description matched.
4. **Match degrees of freedom to the task.** High-freedom text (heuristics) for fuzzy tasks; concrete commands / pseudocode for rigid pipelines.
5. **No marketing.** A skill is teaching, not selling.

## Minimum SKILL.md template

```markdown
---
name: <kebab-case>
description: <one-paragraph trigger description. Mention concrete user phrases that should activate this skill. End with key constraints.>
always: false
metadata:
  agim:
    requires:
      bins: [optional, list, of, cli, binaries]
      env:  [OPTIONAL_ENV_KEYS]
---

# <Display Title>

<1-3 line orientation: when to use, what it produces.>

## When to use

- "trigger phrase 1"
- "trigger phrase 2"

## Steps

1. …
2. …

## Output rules

- Concise example: …
- Don't: …
```

## Frontmatter fields agim respects

| Field | Effect |
|---|---|
| `name` | Must match dir name. Used as the lookup key. |
| `description` | First line shown in skill summary. **Lead with trigger phrases.** |
| `always: true` | Loads full body into every system prompt. Use only for ≤ 200-line skills that apply to >50% of turns (e.g. self-reference). |
| `metadata.agim.requires.bins` | Missing → skill shows `(unavailable: CLI: <bin>)` in summary. |
| `metadata.agim.requires.env` | Same, for env vars. |

## Workflow

1. Decide the **trigger phrases** first; write them down.
2. Draft frontmatter — name + description + requires.
3. Sketch the body in ≤ 100 lines. Resist scope creep.
4. Drop into `~/.agim/skills/<name>/` (workspace). Operator can later promote to builtin via PR.
5. Restart agim to pick it up (loader caches roots at boot).
6. Test: ask the user a trigger-phrase question; verify the agent fetched the body via `read_skill`.

## Subdirectories

- `scripts/` — small executable helpers the body references by path
- `references/` — long-form docs the body cites
- `assets/` — images, schemas, fixtures

The model reads these via its existing file-read tool when the body references them by path.

## Don't

- Don't put secrets (API keys, prod URLs) into SKILL.md — those go to `~/.agim/env`.
- Don't write a skill for one-off requests. Skills are amortised cost.
- Don't duplicate the model's existing knowledge. ("git is a version-control system" wastes tokens.)
- Don't write multi-paragraph descriptions; that's body material.
