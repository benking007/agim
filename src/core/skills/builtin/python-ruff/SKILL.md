---
name: python-ruff
description: Python quality gate with Ruff — check + format --check after Python edits; pyproject.toml defaults; first-run --fix caution. Use on Python repos or when adding lint CI.
always: false
---

# Python Ruff gate

After changing Python, run:

```bash
ruff check .
ruff format --check .
```

Fix findings before claiming the change is done. Prefer `ruff check --fix` only for mechanical auto-fixes; review the remaining diff.

## Install (host / venv)

```bash
# preferred when uv is available
uv tool install ruff
# or
pip install ruff
```

## Project defaults (`pyproject.toml`)

```toml
[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "W", "I", "UP", "B"]
```

## First-run stockpile

Ruff on an older tree often lists many pre-existing issues. Do **not** mass-fix everything in one commit:

1. `ruff check --fix` on the files you touched (or a narrow path).
2. Hand-fix the rest that blocks your change.
3. Leave unrelated debt for a dedicated chore PR.

## CI / pre-commit (optional)

Pre-commit:

```yaml
repos:
  - repo: https://github.com/astral-sh/ruff-pre-commit
    rev: v0.11.0
    hooks:
      - id: ruff
      - id: ruff-format
```

CI step: `ruff check .` before `pytest`.

## Scope note

This skill targets **Python host projects** (e.g. fin-data / ai-agent-platform). The agim-cli TypeScript repo uses Biome + `npm run lint` / `npm test` instead — do not run Ruff as the primary gate there.
