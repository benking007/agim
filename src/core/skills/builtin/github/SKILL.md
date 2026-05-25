---
name: github
description: Interact with GitHub via the `gh` CLI. Use for issues, PRs, CI runs, releases, repo metadata, and gh api queries. Prefer `gh` over raw curl + token because gh handles auth.
always: false
metadata:
  agim:
    requires:
      bins: [gh]
---

# GitHub (`gh` CLI)

`gh` is the authoritative way to talk to GitHub from the shell. It picks up the operator's logged-in account from `~/.config/gh/hosts.yml`. Outside a git repo always pass `--repo owner/repo`.

## Pull requests

```bash
gh pr list  --repo owner/repo --state open --limit 20
gh pr view  123 --repo owner/repo
gh pr diff  123 --repo owner/repo
gh pr checks 123 --repo owner/repo                 # CI status (key for "this PR red 在哪")
gh pr create --repo owner/repo --title "…" --body-file -
gh pr merge  123 --repo owner/repo --squash --auto # auto-merge when CI green
```

## Issues

```bash
gh issue list   --repo owner/repo --state open
gh issue create --repo owner/repo --title "…" --body "…"
gh issue view   456 --repo owner/repo
gh issue close  456 --repo owner/repo --comment "fixed in #789"
```

## CI runs

```bash
gh run list   --repo owner/repo --limit 5
gh run view   <run-id> --repo owner/repo                 # see jobs + step results
gh run view   <run-id> --repo owner/repo --log-failed    # logs of failed steps only
gh run watch  <run-id> --repo owner/repo                 # block until done
gh run rerun  <run-id> --repo owner/repo
```

## Releases & tags

```bash
gh release list   --repo owner/repo
gh release view   v1.2.3 --repo owner/repo
gh release create v1.2.3 --repo owner/repo --notes-file CHANGELOG.md
```

## Raw API for everything else

```bash
gh api repos/owner/repo/contents/path/to/file.ts --jq '.content' | base64 -d
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
gh api graphql -f query='{ viewer { login } }'
```

## Output rules

- Long lists: limit with `--limit` and quote only the top N.
- CI failures: use `--log-failed` and quote the last 40 lines of the failing step, not the whole log.
- For agim-cli itself, the repo is `benking007/agim`.
