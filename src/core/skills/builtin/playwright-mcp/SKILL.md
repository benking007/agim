---
name: playwright-mcp
description: Wire Playwright as an Agim external MCP server for browser navigate/click/assert without one-off scripts. Use when UI smoke tests or dashboard checks need MCP tools.
always: false
---

# Playwright MCP

When Chromium/Playwright is already installed on the host, expose it as an MCP server so the agent can drive the browser via standard tool calls.

## Config (`~/.agim/config.json`)

Merge under the operator MCP map (exact key may be `mcpServers` depending on Agim version — match existing config shape):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

Restart Agim after changing MCP config. Confirm tools appear in the agent tool list (navigate / snapshot / click style names from `@playwright/mcp`).

## Auth / local dashboards

Token-gated UIs (e.g. local dashboard on `:8001` or Agim web on `:3000`) need the session to carry the right header or bootstrap token. Verify auth **before** asserting “UI works”:

1. Open the URL with the same credentials the human uses.
2. Then run click/assert flows.
3. Never paste long-lived secrets into chat; use env or local config files with mode `600`.

## When to use

- Smoke-test a local web UI after a deploy/restart.
- Reproduce a click path that would otherwise need a throwaway Playwright script.

## When not to use

- Pure API / CLI verification — prefer `curl` / unit tests.
- Headless CI of agim-cli itself — that repo already has its own Node/Bun CI, not this MCP.
