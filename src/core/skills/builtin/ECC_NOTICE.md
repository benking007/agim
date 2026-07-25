# ECC skill pack — attribution

Agim ships a **curated 26-skill** subset from the
[ECC](https://github.com/affaan-m/ECC) project (commit cloned 2026-06-12),
licensed under MIT. Each ECC-origin skill is identifiable by:

- `origin: ECC` (or an ECC-related origin) in its `SKILL.md` frontmatter, and/or
- `[ECC]` prefix in its description (added at packaging time)

Operators can disable the entire ECC skill pack via:

```
AGIM_INCLUDE_ECC_SKILLS=off
```

Original license: `ECC_LICENSE` (MIT, © affaan-m).

## Shipped ECC skills (26)

These are also the default `ECC_TOP_PICKS` injection list:

- agent-eval, agent-harness-construction, agent-introspection-debugging,
  agentic-engineering, autonomous-agent-harness, autonomous-loops,
  continuous-learning-v2, verification-loop, prompt-optimizer,
  cost-aware-llm-pipeline, context-budget, team-agent-orchestration
- blueprint, coding-standards, architecture-decision-records,
  backend-patterns, api-design, tdd-workflow, benchmark, code-tour,
  product-capability, product-lens, regex-vs-llm-structured-text,
  article-writing, security-scan, security-bounty-hunter

## Pruned

All other ECC / community ECC-adjacent specialty packs were removed from
`src/core/skills/builtin` (framework/language/industry verticals, Claude Code
ops tooling, content/media packs, and gray-zone community ports such as
`click-path-audit`, `flox-environments`, `plankton-code-quality`,
`santa-method`). Operators can reinstall equivalents under workspace skill
dirs or `~/.agim/skills` if needed.

Agim-native builtins (`agim-*`, `skill-creator`, `github`, `tmux`, …) are
separate from the ECC pack and remain installed.
