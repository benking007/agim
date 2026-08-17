---
name: coding-verify
description: Agim Agent coding loop — edit with agim_edit_file, then agim_diagnostics / agim_test_run / agim_quality_gate, then agim_git_* for commit. Use when implementing or verifying code changes.
always: false
---

# Coding verify loop

Prefer first-class tools over raw `agim_exec` for the edit → check → commit path.

## Edit

1. Read with `agim_read_file` / `agim_grep` / `agim_glob`.
2. Small changes: `agim_edit_file` (exact replace). Large rewrites: `agim_write_file`.
3. Do not claim “done” until a gate below has run on the touched surface.

## Diagnostics (fast)

```
agim_diagnostics({ path: "src/…" })
```

Returns Biome findings as JSON (severity / message / line). Fix before broader gates.

## Tests

```
agim_test_run({ suite: "unit", filter: "src/core/llm/git-dispatcher.test.ts" })
```

Suites: `unit` (default, `npm test`), `web`, `node`, `sqlite`.

## Quality gate (before “成品” claim)

```
agim_quality_gate({ checks: ["lint", "typecheck", "test"] })
```

Or `checks: ["full"]` → `npm run verify:release` when the repo defines it.

## Git

```
agim_git_status({})
agim_git_diff({})
agim_git_add({ paths: ["…"] })
agim_git_commit({ message: "fix: …" })
```

Never use tools for `push --force` / `reset --hard` — those stay on explicit `agim_exec` + human confirmation.

## Plan mode

While plan mode is on: diagnostics + git status/diff/log are allowed; write/edit/exec/git add|commit/test/quality_gate are blocked.
