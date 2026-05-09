# AGENTS.md

## Cursor Cloud specific instructions

### Overview

im-hub-pro is a universal messenger-to-agent bridge (Node.js/TypeScript). Single process, no Docker, no Redis. Web UI on port 3000, ACP server on port 9090.

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

1. The app requires a config at `~/.im-hub/config.json`. Without it, an interactive onboarding wizard starts and exits on cancel. Create a minimal config to skip onboarding:

```json
{
  "messengers": ["telegram"],
  "agents": ["claude-code"],
  "defaultAgent": "claude-code",
  "telegram": { "botToken": "placeholder" }
}
```

2. The app checks agent CLI availability via `<command> --version`. At least one agent CLI must be on PATH or the app exits. A stub script at `/usr/local/bin/claude` satisfies this check.

3. After `npm run build`, start with `node dist/cli.js start`. Web UI at `http://localhost:3000`, health check at `/api/health` (unauthenticated). Login token is stored in `~/.im-hub/web-token`.

### Testing notes

- Tests use **bun** as the test runner (`bun test`). Ensure `~/.bun/bin` is on PATH.
- `npm run typecheck` runs two passes: src (via `tsconfig.json`) and test (via `tsconfig.test.json`). The test pass currently has pre-existing TS errors in `test/unit/agent-base.test.ts` (accessing protected members) — these do not affect runtime.
- Biome lint exits 0 with warnings only (no errors in the current codebase).

### Native addon

`better-sqlite3` requires a C++ build toolchain (gcc/g++, make, python3). These are typically pre-installed on the VM.
