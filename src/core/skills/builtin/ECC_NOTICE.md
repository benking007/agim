# ECC skill pack — attribution

Agim v1.2.148+ ships a curated subset of **230 skills** from the
[ECC](https://github.com/affaan-m/ECC) project (commit cloned 2026-06-12),
licensed under MIT. Each ECC-origin skill is identifiable by:

- `origin: ECC` in its `SKILL.md` frontmatter
- `[ECC]` prefix in its description (added at packaging time)

Operators can disable the entire ECC skill pack via:

```
AGIM_INCLUDE_ECC_SKILLS=off
```

Original license: `ECC_LICENSE` (MIT, © affaan-m).

Excluded from the import (32 skills): ECC-internal tooling
(configure-ecc, ecc-tools-*), ECC operator workflows (brand-voice,
customer-billing-ops, google-workspace-ops, project-flow-ops, …),
ito-* (4) prediction-market pack, homelab-* (5), video-generation
(manim/remotion/blender), social-publisher, investor-materials/outreach.

Re-imported after the initial cut (operator decision):
- `content-engine` — cross-platform content systems (X / LinkedIn /
  TikTok / YouTube / newsletter / repurposing). Originally excluded
  with the operator-workflow group; promoted into the recommended-32
  injection list as a general content-writing tool.
