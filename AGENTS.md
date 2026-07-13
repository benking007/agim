# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Agim is a universal messenger-to-agent bridge (Node.js >= 22.19/TypeScript). Single process, no Docker, no Redis. Web UI on port 3000, ACP server on port 9090.

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

- npm publication is driven by `.github/workflows/release.yml`, not by pushing a git tag. The normal release path is: bump `package.json` (and `package-lock.json`), commit to `main`, then push `main`. The workflow triggers only on `push` to `main` when `package.json` changed; it publishes with GitHub Actions auth (`NPM_TOKEN` / trusted publishing).
- If the local push fails with HTTPS credential errors (for example a 403 despite the right GitHub username), switch the repository remote to SSH and retry: `git remote set-url origin git@github.com:benking007/agim.git`. Verify the key with `ssh -T git@github.com`; local `npm whoami` is not required for the official release because npm publish happens in GitHub Actions.
- After the workflow finishes, confirm both sides: the Actions run named `Publish to npm` is green, and `npm view agim-cli version` returns the bumped version.

### Running the app locally

1. The app requires a config at `~/.agim/config.json`. Without it, an interactive onboarding wizard starts and exits on cancel. Create a minimal config to skip onboarding:

```json
{
  "messengers": ["telegram"],
  "agents": ["agim", "claude-code"],
  "defaultAgent": "agim",
  "telegram": { "botToken": "placeholder" }
}
```

2. The app checks agent CLI availability via `<command> --version`. At least one agent CLI must be on PATH or the app exits. A stub script at `/usr/local/bin/claude` satisfies this check.

3. After `npm run build`, start with `node dist/cli.js start`. Web UI at `http://localhost:3000` (token-gated unless `AGIM_WEB_AUTH=off`). On first boot the server writes a one-time raw token to `~/.agim/web-bootstrap-token` (chmod 600). Retrieve it with `agim token bootstrap` or `cat ~/.agim/web-bootstrap-token` — **not** `agim token list` (that only shows hashes). ACP endpoint at `http://localhost:9090` uses a bearer token from the access-token registry (`~/.agim/tokens.json`; legacy `~/.agim/acp-token` may still exist on older installs and is cleaned on uninstall).

### Testing notes

- Tests use **bun** as the test runner (`npm test` → `bun test --isolate`). Isolation is required because many files mutate process env, registries, and socket listeners. Bun is pinned as a devDependency, so `npm ci` provides `node_modules/.bin/bun` even when `~/.bun/bin` is not on PATH.
- `npm run typecheck` runs two passes: src (via `tsconfig.json`) and test (via `tsconfig.test.json`). Both passes are expected to exit 0.
- `npm run lint` covers both backend and SPA sources. It is expected to exit 0; the SPA scope should remain free of warnings as well as errors.
- The SPA `postbuild` enforces bundle budgets (350 KiB entry, 400 KiB per JavaScript chunk). Do not raise them to hide a regression; split the dependency or route instead.
- Bun cannot load `better-sqlite3`, so DB-backed Bun cases skip intentionally. `npm run test:sqlite` reuses those backend test files through Vitest's Node pool and exercises the real native addon. `npm run test:node` runs the built-memory smoke tests plus that full SQLite suite and is the CI/release gate.

### Native addon

`better-sqlite3` requires a C++ build toolchain (gcc/g++, make, python3). These are typically pre-installed on the VM.
