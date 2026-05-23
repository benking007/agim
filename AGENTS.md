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

0. **Install the `agim` CLI on PATH** (Cloud Desktop / dev VM often skip this):

```bash
cd /path/to/agim && npm install && npm run build
npm link    # puts `agim` in your npm global bin (e.g. ~/.nvm/.../bin/agim)
agim --version
```

Without `npm link` / `npm install -g`, only `node dist/cli.js …` works — a bare `agim` shell command will report “command not found”.

1. **Web 后台 v2 (default ON since 1.2.22).** Do **not** set `IMHUB_WEB_V2=0` unless you intentionally need the legacy v1 HTML pages. Unset or omit the variable; the server serves the React SPA from `dist/web/public/` (`/`, `/settings/llm`, `/tasks/heartbeat`, etc.). Setting `IMHUB_WEB_V2=0` disables the SPA asset router and can white-screen new installs.

2. The app requires a config at `~/.agim/config.json`. Without it, an interactive onboarding wizard starts and exits on cancel. Create a minimal config to skip onboarding:

```json
{
  "messengers": ["telegram"],
  "agents": ["claude-code"],
  "defaultAgent": "claude-code",
  "telegram": { "botToken": "placeholder" }
}
```

2. The app checks agent CLI availability via `<command> --version`. At least one agent CLI must be on PATH or the app exits. A stub script at `/usr/local/bin/claude` satisfies this check.

3. After `npm run build`, start with `node dist/cli.js start`. Web UI at `http://localhost:3000` (no built-in auth — access control is upstream). ACP endpoint at `http://localhost:9090` uses a bearer token stored in `~/.agim/acp-token` (legacy fallback: `~/.agim/web-token`).

### Testing notes

- Tests use **bun** as the test runner (`bun test`). Ensure `~/.bun/bin` is on PATH.
- `npm run typecheck` runs two passes: src (via `tsconfig.json`) and test (via `tsconfig.test.json`). The test pass currently has pre-existing TS errors in `test/unit/agent-base.test.ts` (accessing protected members) — these do not affect runtime.
- Biome lint exits 0 with warnings only (no errors in the current codebase).

### Native addon

`better-sqlite3` requires a C++ build toolchain (gcc/g++, make, python3). These are typically pre-installed on the VM.
