# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Agim is a universal messenger-to-agent bridge (Node.js/TypeScript). Single process, no Docker, no Redis. Web UI on port 3000, ACP server on port 9090.

### Commands

| Task | Command |
|------|---------|
| Install deps | `npm install --no-package-lock` (see note below) + `npm --prefix src/web-app install` |
| Build | `npm run build` |
| Dev (watch) | `npm run dev` |
| Lint | `npx biome lint src test` |
| Typecheck (src) | `npx tsc --noEmit` |
| Test | `bun test` |
| Start | `node dist/cli.js start` |

### Dependency install caveat (important)

The committed root `package-lock.json` has ~107 entries whose `resolved` URLs point at an internal mirror (`mirrors.tencentyun.com`) that is **not reachable** from the Cursor Cloud VM. A plain `npm install` therefore crashes (`Exit handler never called` / `ENOTFOUND`). Install with `npm install --no-package-lock` so npm ignores those baked-in URLs and resolves everything (including optional deps like the Biome platform binary) from the configured public registry (`registry.npmjs.org`). The startup update script already does this — fresh sessions need no manual step.

- Building the web UI (`npm run build` → `build:spa`) compiles the Vite SPA in `src/web-app`, which has its own `package.json` (no lockfile). Its deps are installed by `npm --prefix src/web-app install`.
- The optional `@xenova/transformers` dep (local vector embeddings, default OFF) is heavy; it installs fine with `--no-package-lock` but is not required to run, lint, build, or test the app.

### Release / publish notes

- npm publication is driven by `.github/workflows/release.yml`, not by pushing a git tag. The normal release path is: bump `package.json` (and `package-lock.json`), commit to `main`, then push `main`. The workflow triggers only on `push` to `main` when `package.json` changed; it publishes with GitHub Actions auth (`NPM_TOKEN` / trusted publishing).
- If the local push fails with HTTPS credential errors (for example a 403 despite the right GitHub username), switch the repository remote to SSH and retry: `git remote set-url origin git@github.com:benking007/agim.git`. Verify the key with `ssh -T git@github.com`; local `npm whoami` is not required for the official release because npm publish happens in GitHub Actions.
- After the workflow finishes, confirm both sides: the Actions run named `Publish to npm` is green, and `npm view agim-cli version` returns the bumped version.

### Running the app locally

1. The app requires a config at `~/.agim/config.json`. Without it, an interactive onboarding wizard starts and exits on cancel. Create a minimal config to skip onboarding:

```json
{
  "messengers": ["telegram"],
  "agents": ["native", "claude-code"],
  "defaultAgent": "native",
  "telegram": { "botToken": "placeholder" }
}
```

2. The app checks agent CLI availability via `<command> --version`. At least one agent CLI must be on PATH or the app exits. A stub script at `/usr/local/bin/claude` satisfies this check.

3. After `npm run build`, start with `node dist/cli.js start`. Web UI at `http://localhost:3000` (token-gated unless `AGIM_WEB_AUTH=off`). On first boot the server writes a one-time raw token to `~/.agim/web-bootstrap-token` (chmod 600). Retrieve it with `agim token bootstrap` or `cat ~/.agim/web-bootstrap-token` — **not** `agim token list` (that only shows hashes). ACP endpoint at `http://localhost:9090` uses a bearer token stored in `~/.agim/acp-token` (legacy fallback: `~/.agim/web-token`).

### Testing notes

- Tests use **bun** as the test runner (`npm test` → `bun test`). Bun is pinned as a devDependency, so `npm install` provides `node_modules/.bin/bun` even when `~/.bun/bin` is not on PATH.
- `npm run typecheck` runs two passes: src (via `tsconfig.json`) and test (via `tsconfig.test.json`). Both passes are expected to exit 0.
- `npm run lint` is expected to exit 0. Biome may still print warnings / infos; those are not blocking unless promoted to errors by config.
- A small number of tests (~9) fail in the **full** `bun test` run on the Cursor Cloud VM but pass in isolation. They are not dependency/setup problems: the `findAgimProcesses` / `reapStrayAgimProcesses` cases (`test/unit/reap-stray-processes.test.ts`) depend on spawning real processes and matching them via `/proc` argv, which the sandboxed container does not reproduce; the `nativeAgentAdapter` / `registry.listAgents` / `runAgentLoop` cases pass when their file is run alone (cross-test global-state pollution in the full run). The other ~2038 tests pass.

### Native addon

`better-sqlite3` requires a C++ build toolchain (gcc/g++, make, python3). These are typically pre-installed on the VM.
