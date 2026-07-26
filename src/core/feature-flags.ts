// Compliance-driven feature flags.
//
// Global IM defaults to OFF — Discord/Telegram messengers are hidden
// from every entry point unless the operator explicitly opts in via env.
//
// Rationale: mainland-China policy compliance — Discord/Telegram are not
// appropriate for default deployments in restricted environments.
// Operators who need them set the env var; the codebase carries no UI
// breadcrumb of this flag so an unprivileged user browsing settings
// cannot discover it.
//
// Keep this file the SINGLE source of truth for IM visibility gates.

/** True when AGIM_ENABLE_GLOBAL_IM=1. Controls visibility of
 *  Discord + Telegram messengers across CLI wizard, web settings,
 *  and runtime adapter registration. */
export function isGlobalImEnabled(): boolean {
  return process.env.AGIM_ENABLE_GLOBAL_IM === '1'
}
