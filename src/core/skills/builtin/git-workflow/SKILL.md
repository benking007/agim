---
name: git-workflow
description: Git discipline for Agim coding sessions — baseline status/diff, conventional commits, self-review before commit, safe rollback. Use before any commit/push or when recovering from a bad edit.
always: false
---

# Git workflow

Keep changes reviewable and reversible. Prefer one logical change per commit.

## Before editing

```bash
git status
git diff
git diff --stat
```

Record the baseline. For high-risk single-file edits, copy a backup first:

```bash
cp path/to/file path/to/file.bak.$(date +%Y%m%d%H%M%S)
```

Prefer surgical edits (`agim_edit_file` / exact patch) over whole-file overwrite when only a small region changes.

## Before commit — self-review

1. `git diff --stat` — confirm the file set matches the intent (no stray debug files).
2. Scan the diff for secrets (API keys, tokens, `.env` contents) and debug leftovers (`console.log` dumps, temporary TODOs you meant to remove).
3. Run the project’s quality gate when applicable (`npm test`, `ruff check .`, etc.).

## Commit message

Use conventional commits, one change per commit:

- `fix:` bug fix
- `feat:` user-visible feature
- `chore:` tooling / deps / non-product
- `refactor:` behavior-preserving restructure
- `test:` tests only
- `docs:` docs only

Example: `fix(fs): expose agim_edit_file on native agent`

Do not batch unrelated fixes into one commit.

## Rollback

| Situation | Safe move |
|---|---|
| Unstaged bad edit | `git checkout -- <file>` (after backup if unsure) |
| Last commit is wrong but pushed as PR | new `git revert <sha>` commit |
| Need to undo local unpushed commit | `git reset --soft HEAD~1` only when you own the branch and understand the risk |

## Hard bans

- Never `git push --force` to shared branches (`main`, release branches).
- Never `git reset --hard` without an explicit operator confirmation and a backup (`git stash` or branch tip noted).
- Never rewrite history on a branch others may have pulled.

## Push checklist

```bash
git status
git log -3 --oneline
git push -u origin <branch>
```

If push fails on credentials, fix remotes/auth — do not force-push as a workaround.
