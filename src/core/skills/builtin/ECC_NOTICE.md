# ECC skill pack — attribution

Agim v1.2.148+ ships a curated subset of **229 skills** from the
[ECC](https://github.com/affaan-m/ECC) project (commit cloned 2026-06-12),
licensed under MIT. Each ECC-origin skill is identifiable by:

- `origin: ECC` in its `SKILL.md` frontmatter
- `[ECC]` prefix in its description (added at packaging time)

Operators can disable the entire ECC skill pack via:

```
IMHUB_INCLUDE_ECC_SKILLS=off
```

Original license: `ECC_LICENSE` (MIT, © affaan-m).

Excluded from the import (33 skills): ECC-internal tooling
(configure-ecc, ecc-tools-*), ECC operator workflows (brand-voice,
customer-billing-ops, google-workspace-ops, project-flow-ops, …),
ito-* (4) prediction-market pack, homelab-* (5), video-generation
(manim/remotion/blender), social-publisher, investor-materials/outreach.
