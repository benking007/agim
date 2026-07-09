// live-config — singleton holding the current in-process Config.
//
// Why this exists (v1.2.103):
//   Before this module, three subsystems captured `config.defaultAgent`
//   at boot time as a value snapshot:
//     - startWebServer(options.defaultAgent)
//     - startACPServer(options.defaultAgent)
//     - cli.ts onMessage → routeCtx.defaultAgent = config.defaultAgent
//   The PUT /api/config endpoint persisted changes to disk but never
//   refreshed those snapshots, so flipping the default Agent in the SPA
//   only took effect after a service restart.
//
//   Similarly, `config.agents[]` (the SPA's enable / disable toggle for
//   each built-in agent) was persisted but never consulted by
//   registry.findAgent / listAgents. Disabling 'codex' in the SPA
//   silently did nothing — the agent stayed routable + counted toward
//   intent classification.
//
// Contract:
//   - setLiveConfig() is the single mutation point. cli.ts calls it
//     once at boot; PUT /api/config calls it again after every save.
//   - getLiveConfig() returns the most recently set Config or `null`
//     (very early boot, before cli.ts has finished loading config).
//   - getDefaultAgent() / isAgentEnabled() encode the policy callers
//     want — they never expose the raw Config and they degrade to safe
//     defaults when no config is loaded yet.
//
//   Empty `agents: []` (legacy installs that never configured the list)
//   is treated as "all installed agents enabled" — back-compat. Only an
//   explicit non-empty list filters.

import type { Config } from './types.js'

let current: Config | null = null

/** Replace the live config. Called once at boot, then again on every
 *  successful PUT /api/config. */
export function setLiveConfig(cfg: Config): void {
  current = cfg
}

/** Return the live Config or null if not yet set. Most callers should
 *  use the typed accessors below instead of inspecting raw fields. */
export function getLiveConfig(): Config | null {
  return current
}

/** The Config's `defaultAgent` field, with a fallback for very early
 *  callers (e.g. a tool fires before cli.ts has finished boot). */
export function getDefaultAgent(fallback = 'native'): string {
  return current?.defaultAgent || fallback
}

/** True iff `name` is in the operator's enabled-agent list. Empty list
 *  or no-config-loaded → "allow all" for back-compat with installs that
 *  never configured the list explicitly. */
export function isAgentEnabled(name: string): boolean {
  // The in-process `native` agent is always available: it needs no
  // install, is registered unconditionally, and historically was never
  // required to appear in config.agents. Filtering it (v1.2.103
  // regression) broke `/na` and default routing for installs whose
  // enabled list predates native. Never filter it.
  //
  // v1.2.140 — the admin SPA now shows native in /settings/agents with
  // a working toggle. That toggle is a "user preference / default-picker
  // eligibility" signal, NOT a routing kill-switch: native stays
  // reachable via `/na` even with the box unchecked. If a future change
  // wants to honour the toggle as a hard disable, drop this short-
  // circuit AND ship a migration that adds 'native' to existing configs
  // missing the entry.
  if (name === 'native') return true
  if (!current) return true
  const list = current.agents
  if (!list || list.length === 0) return true
  // The configured default agent must always be reachable — otherwise an
  // enabled list that doesn't explicitly include the default would make
  // unrouted messages fail. Exempt it from the filter.
  if (name === (current.defaultAgent || '')) return true
  return list.includes(name)
}

/** Visible for test. Resets the singleton between tests. NOT exposed
 *  through index/barrel exports — runtime callers should never reach
 *  for this. */
export function __resetLiveConfigForTest(): void {
  current = null
}
