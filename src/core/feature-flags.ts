// Compliance-driven feature flags.
//
// Both flags default to OFF — the underlying surfaces (Discord/Telegram
// messengers, ACP remote agents) are hidden from every entry point
// (install wizard, web settings UI, web API response, runtime adapter
// load) unless the operator explicitly opts in via env.
//
// Rationale: mainland-China policy compliance — these channels and
// remote-agent endpoints are not appropriate for default deployments
// in restricted environments. Operators who need them set the env
// var; the codebase carries no UI breadcrumb of these flags so an
// unprivileged user browsing settings cannot discover them.
//
// Keep this file the SINGLE source of truth — every gate elsewhere
// imports from here so a future audit can grep `isGlobalImEnabled` /
// `isRemoteAgentEnabled` and verify coverage.

/** True when AGIM_ENABLE_GLOBAL_IM=1. Controls visibility of
 *  Discord + Telegram messengers across CLI wizard, web settings,
 *  and runtime adapter registration. */
export function isGlobalImEnabled(): boolean {
  return process.env.AGIM_ENABLE_GLOBAL_IM === '1'
}

/** True when AGIM_ENABLE_REMOTE_AGENT=1. Controls visibility of the
 *  ACP (remote-agent-over-HTTP) feature across CLI wizard, web
 *  settings, and ACP agent registration. Local agents (claude-code,
 *  codex, opencode) are unaffected. */
export function isRemoteAgentEnabled(): boolean {
  return process.env.AGIM_ENABLE_REMOTE_AGENT === '1'
}
