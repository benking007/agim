# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Agim is a universal messenger-to-agent bridge (Node.js >= 22.19/TypeScript). Single process, no Docker, no Redis. Web UI on port 3000.

### Commands

| Task | Command |
|------|---------|
| Install deps | `npm ci` + `npm --prefix src/web-app ci` |
| Build | `npm run build` |
| Dev (watch) | `npm run dev` |
| Lint | `npm run lint` |
| Typecheck (src) | `npx tsc --noEmit` |
| Test | `npm test` |
| Start | `node dist/cli.js start` |

### Dependency installation

Both the root project and `src/web-app` commit npm v3 lockfiles whose tarballs resolve from the public npm registry. Use `npm ci` so local, CI, and release installs use the same dependency graph.

- Building the web UI (`npm run build` → `build:spa`) compiles the Vite SPA in `src/web-app`, which has its own `package.json` and `package-lock.json`.
- The optional `@huggingface/transformers` dependency powers local vector embeddings and is relatively large. CI may use `npm ci --omit=optional`; a normal local or end-user install includes it.

### Release / publish notes

- npm publication is driven by `.github/workflows/release.yml`, not by pushing a git tag.
- **Preferred path:** merge a PR → `Auto Version Bump` patches `package.json` → the same workflow **calls** Publish via `workflow_call` (bot pushes alone do **not** trigger the push-based Publish hook; that gap previously left npm at 1.5.21 while git reached 1.5.25).
- **Manual / fallback:** bump `package.json` (+ lockfile) in a non-bot commit on `main`, or run Actions → "Publish to npm" → `workflow_dispatch`.
- After publish: confirm the Actions run is green **and** `npm view agim-cli version` matches `package.json`. Locally: `npm run check:npm-drift` (CI fails on `main` when drift is ≥2 patches).
- If a local push fails with HTTPS credential errors, switch to SSH: `git remote set-url origin git@github.com:benking007/agim.git`.

### Running the app locally

1. The app requires a config at `~/.agim/config.json`. Without it, `agim` / `agim go` start the service and open `/setup` in the browser (or `agim config` for the advanced CLI). For a non-interactive stub that skips IM:

```json
{
  "messengers": [],
  "agents": ["agim", "claude-code"],
  "defaultAgent": "agim"
}
```

Web-console-only is valid — empty `messengers` no longer blocks `agim start`. Telegram/Discord stay hidden unless `AGIM_ENABLE_GLOBAL_IM=1`.

2. First-run `agim start` may boot with no CLI agent and no LLM key so `/setup` can run. After setup, at least one agent must be usable: a CLI on PATH (`<command> --version`), or Agim Agent with `llmBackends` + a key in `~/.agim/llm-secrets.json`. A stub `/usr/local/bin/claude` satisfies the CLI check for cloud VMs (and clears `firstRun`). For local SPA debugging without tokens, `AGIM_WEB_AUTH=off` is fine on loopback.

3. After `npm run build`, start with `node dist/cli.js start` (or `agim start --bg`). Web UI at `http://localhost:3000` (token-gated unless `AGIM_WEB_AUTH=off` or loopback trust). On first boot the server writes a one-time raw token to `~/.agim/web-bootstrap-token` (chmod 600). Retrieve it with `agim token bootstrap` or `cat ~/.agim/web-bootstrap-token` — **not** `agim token list` (that only shows hashes).

### Testing notes

- Tests use **bun** as the test runner (`npm test` → `bun test --isolate`). Isolation is required because many files mutate process env, registries, and socket listeners. Bun is pinned as a devDependency, so `npm ci` provides `node_modules/.bin/bun` even when `~/.bun/bin` is not on PATH.
- `npm run typecheck` runs two passes: src (via `tsconfig.json`) and test (via `tsconfig.test.json`). Both passes are expected to exit 0.
- `npm run lint` covers both backend and SPA sources. It is expected to exit 0; the SPA scope should remain free of warnings as well as errors.
- The SPA `postbuild` enforces bundle budgets (350 KiB entry, 400 KiB per JavaScript chunk). Do not raise them to hide a regression; split the dependency or route instead.
- Bun cannot load `better-sqlite3`, so DB-backed Bun cases skip intentionally. `npm run test:sqlite` reuses those backend test files through Vitest's Node pool and exercises the real native addon. `npm run test:node` runs the built-memory smoke tests plus that full SQLite suite and is the CI/release gate.

### Native addon

`better-sqlite3` requires a C++ build toolchain (gcc/g++, make, python3). These are typically pre-installed on the VM.

### Coding-environment skills (Agim Agent)

Builtin skills under `src/core/skills/builtin/` for AI coding ops (activate via skill discovery / `read_skill` when relevant):

| Skill | Purpose |
|------|---------|
| `git-workflow` | status/diff baseline, conventional commits, safe rollback; no force-push |
| `coding-verify` | edit → diagnostics → test → quality_gate → git commit loop |
| `systemd-ops` | `systemctl` / `journalctl`, restart + `/health`, hung PID handling |
| `python-ruff` | Ruff check/format gate for **Python** host projects (not this TS repo) |
| `playwright-mcp` | Wire `@playwright/mcp` into `~/.agim` MCP config for UI smoke tests |
| `exec-sandbox` | bubblewrap / `AGIM_EXEC_SANDBOX` defaults and smoke checks |

Native Agim filesystem tools include `agim_edit_file` (exact string replace) in addition to `agim_write_file`. Prefer edit for small surgical changes.

Coding tools (first-class, prefer over `agim_exec`):

| Tool | Role |
|------|------|
| `agim_git_status` / `diff` / `log` | read-only git |
| `agim_git_add` / `commit` | staged commit (no push; approval-gated) |
| `agim_diagnostics` | Biome JSON findings for a path |
| `agim_test_run` | structured `npm test` / web / node / sqlite |
| `agim_quality_gate` | lint + typecheck + test (or `full` → verify:release) |

Operators enable optional packs (`git`, `codingGate`) under **Settings → Tools & Plugins** (`/settings/tools`). Unchecked packs are omitted from the Agim Agent tool list and system prompt. Core fs / web (`agim_web_fetch` / `agim_web_search`) / exec / `mcp__agim__*` stay always on.

Exec isolation: when bubblewrap is installed, unset `AGIM_EXEC_SANDBOX` defaults toward sandbox-on for `agim_exec` / writes; set `AGIM_EXEC_SANDBOX=off` only when intentionally unconfined. See builtin skill `exec-sandbox`.

### Host bootstrap (P0/P1 tools)

On a coding host (or this Cloud VM), install uv/ruff/bwrap + wire Playwright MCP:

```bash
bash scripts/coding-env-host-bootstrap.sh
# restart agim, then: agim setup mcp health playwright
```

- Does **not** overwrite an existing `git config --global user.*` (Cloud Agents keep signed identity). On a blank Agim box you may set `Agim Agent` / `agim@local`.
- `agim setup mcp add` now offers a **Playwright** preset.
- systemd ops skill applies on real systemd hosts; this Cloud container often has no PID 1 systemd bus.
- This repo already has `.github/workflows/ci.yml` (Biome/Bun), not a Python Ruff CI.
