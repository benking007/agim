# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Agim is a universal messenger-to-agent bridge (Node.js/TypeScript). Single process, no Docker, no Redis. Web UI on port 3000, ACP server on port 9090.

### Commands

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Build | `npm run build` |
| Dev (watch) | `npm run dev` |
| Lint | `npx biome lint src test` |
| Typecheck (src) | `npx tsc --noEmit` |
| Test | `bun test` |
| Start | `node dist/cli.js start` |

### Running the app locally

1. The app requires a config at `~/.agim/config.json`. Without it, an interactive onboarding wizard starts and exits on cancel. Create a minimal config to skip onboarding:

```json
{
  "messengers": ["telegram"],
  "agents": ["claude-code"],
  "defaultAgent": "claude-code",
  "telegram": { "botToken": "placeholder" }
}
```

2. The app checks agent CLI availability via `<command> --version`. At least one agent CLI must be on PATH or the app exits. A stub script at `/usr/local/bin/claude` satisfies this check.

3. After `npm run build`, start with `node dist/cli.js start`. Web UI at `http://localhost:3000` (token-gated unless `IMHUB_WEB_AUTH=off`). On first boot the server writes a one-time raw token to `~/.agim/web-bootstrap-token` (chmod 600). Retrieve it with `agim token bootstrap` or `cat ~/.agim/web-bootstrap-token` — **not** `agim token list` (that only shows hashes). ACP endpoint at `http://localhost:9090` uses a bearer token stored in `~/.agim/acp-token` (legacy fallback: `~/.agim/web-token`).

### Testing notes

- Tests use **bun** as the test runner (`npm test` → `bun test`). Bun is pinned as a devDependency, so `npm install` provides `node_modules/.bin/bun` even when `~/.bun/bin` is not on PATH.
- `npm run typecheck` runs two passes: src (via `tsconfig.json`) and test (via `tsconfig.test.json`). Both passes are expected to exit 0.
- `npm run lint` is expected to exit 0. Biome may still print warnings / infos; those are not blocking unless promoted to errors by config.

### Native addon

`better-sqlite3` requires a C++ build toolchain (gcc/g++, make, python3). These are typically pre-installed on the VM.
