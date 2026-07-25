# ECC skill pack — attribution

Agim ships a curated subset of skills from the
[ECC](https://github.com/affaan-m/ECC) project (commit cloned 2026-06-12),
licensed under MIT. Each ECC-origin skill is identifiable by:

- `origin: ECC` in its `SKILL.md` frontmatter
- `[ECC]` prefix in its description (added at packaging time)

Operators can disable the entire ECC skill pack via:

```
AGIM_INCLUDE_ECC_SKILLS=off
```

Original license: `ECC_LICENSE` (MIT, © affaan-m).

## Pruned from the shipped pack

Framework / language / industry specialty packs and a few ECC-internal
tooling skills were removed from `src/core/skills/builtin` to shrink the
default install surface (operators can still install equivalents under
`~/.agim/skills` or workspace skill dirs). Notable removals include:

- `security-review`, `content-engine`, `openclaw-persona-forge`
- `django-*`, `frontend-*`, `healthcare-*`, `kotlin-*`, `laravel-*`
- `motion-*`, `network-*`, `orch-*`, `perl-*`, `quarkus-*`, `react-*`
- `skill-comply` / `skill-scout` / `skill-stocktake`
- `springboot-*`, `swift-*`

Kept security-adjacent ECC skills: `security-scan`, `security-bounty-hunter`.
Kept authoring tooling: `skill-creator`.
