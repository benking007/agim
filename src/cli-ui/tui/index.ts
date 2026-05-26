// agim TUI entry — wired into `agim tui` subcommand.
//
// Loads the minimum runtime needed to drive an agent in-process:
//   1. Read ~/.agim/config.json so registry knows about ACP agents
//   2. Register all built-in agent adapters (claude-code / codex / native / …)
//   3. Hand off to <TuiApp /> which renders the Ink UI
//
// We deliberately skip starting the messengers / web server / approval bus
// — TUI talks to agents directly. Future "remote client" mode (talk to
// running daemon over HTTP+SSE) will live in a sibling file.

import React from 'react'
import { render } from 'ink'

import { TuiApp } from './app.js'
import { registry } from '../../core/registry.js'
import { loadConfig } from '../../core/onboarding.js'
import { logger as rootLogger } from '../../core/logger.js'

const log = rootLogger.child({ component: 'tui' })

export interface TuiOptions {
  agent?: string
}

export async function runTui(opts: TuiOptions = {}): Promise<void> {
  // Sanity: a real TTY is required. Without one Ink's stdin handling
  // breaks and the user sees nothing. Refuse cleanly so they know why.
  if (!process.stdout.isTTY) {
    console.error('agim tui: stdout is not a TTY — TUI requires an interactive terminal.')
    process.exit(1)
  }

  // v1.2.76 — silence the root logger BEFORE loading plugins.
  // pino-pretty writes to fd 1 (same as Ink). Without this, the
  // registry's "Plugin registry initialized" + every other startup
  // info log scrambles Ink's diff renderer — header banner gets
  // repeated 5+ times stacked because Ink can't reconcile the
  // interleaved foreign output.
  // We trade log visibility during the TUI session for a clean UI;
  // users can opt back in with IMHUB_TUI_VERBOSE=1 (logs go to
  // stderr instead of being suppressed entirely, which still
  // collides with Ink but at least is grep-friendly through 2>file).
  const wantVerbose = process.env.IMHUB_TUI_VERBOSE === '1'
  const savedLevel = rootLogger.level
  if (!wantVerbose) {
    rootLogger.level = 'silent'
  }
  // Clear the screen + park the cursor at top-left so Ink draws on a
  // blank canvas. Anything that printed before us (build output,
  // shell PS1, etc.) gets pushed off-screen into scrollback.
  process.stdout.write('\x1b[2J\x1b[H')

  // Load registry — messengers + agents. Messengers won't be started
  // (registry registers; the IM loop in `agim start` is what actually
  // connects them), so this is cheap and gives us alias resolution.
  // ACP agents come from config.json; if it can't load, fall through
  // with built-ins only.
  try {
    await registry.loadBuiltInPlugins()
    const cfg = await loadConfig()
    if (cfg.acpAgents && cfg.acpAgents.length > 0) {
      await registry.loadACPAgents(cfg.acpAgents)
    }
  } catch (err) {
    log.warn({ event: 'tui.registry.load_failed', err: err instanceof Error ? err.message : String(err) },
      'registry / config load failed — proceeding best-effort')
  }

  // Resolve --agent if supplied; otherwise the App picks the first
  // available adapter on mount.
  let initialAgent = opts.agent
  if (initialAgent) {
    const found = registry.findAgent(initialAgent)
    if (!found) {
      const list = registry.listAgents()
      console.error(
        `agim tui: agent "${initialAgent}" not found. Available: ${list.join(', ') || '<none>'}`,
      )
      process.exit(1)
    }
    initialAgent = found.name
  }

  const { waitUntilExit } = render(
    React.createElement(TuiApp, { initialAgent }),
    {
      // patchConsole=true makes Ink intercept console.* calls and queue
      // them above the live region — without it any stray console.log
      // (e.g. from a 3rd-party SDK) corrupts the canvas mid-stream.
      patchConsole: true,
      exitOnCtrlC: true,
    },
  )
  try {
    await waitUntilExit()
  } finally {
    // Restore root logger level so subsequent commands in the same
    // shell session see normal log output.
    rootLogger.level = savedLevel
  }
}
