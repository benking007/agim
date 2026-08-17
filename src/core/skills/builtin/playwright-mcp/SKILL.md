---
name: playwright-mcp
description: Wire Playwright as an Agim external MCP server for browser navigate/click/assert without one-off scripts. Use when UI smoke tests or dashboard checks need MCP tools.
always: false
---

# Playwright MCP

When Chromium/Playwright is already installed on the host, expose it as an MCP server so the agent can drive the browser via standard tool calls.

## One-shot host bootstrap

From the agim checkout:

```bash
bash scripts/coding-env-host-bootstrap.sh
# restart agim, then:
agim setup mcp health playwright
```

Or add via wizard (`agim setup mcp add` → Playwright preset).

## Config (`~/.agim/config.json`)

Agim uses an **array** under `mcpServers` (not a map):

```json
{
  "mcpServers": [
    {
      "name": "playwright",
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "enabled": true
    }
  ]
}
```

Restart Agim after changing MCP config. Tools appear as `mcp_playwright_*`.

## Auth / local dashboards

Token-gated UIs need the session to carry the right header or bootstrap token. Verify auth before asserting “UI works”. Never paste long-lived secrets into chat.

## When to use

- Smoke-test a local web UI after deploy/restart.
- Reproduce a click path without a throwaway Playwright script.

## When not to use

- Pure API / CLI checks — use `curl` / unit tests.
- agim-cli CI already uses Bun/Biome; do not swap that for Playwright MCP.
