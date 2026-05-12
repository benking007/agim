// agim-paths.ts — resolve the per-user state directory + workspace tree.
//
// v1.0 brand rebrand introduced canonical names `~/.agim/` and
// `~/.agim-workspaces/`. To keep every 0.x deployment intact, this
// module *auto-detects* which name the user already has on disk and
// sticks with that. Fresh installs land at the new name. No data is
// ever moved automatically — we just pick the right root and stay there.
//
// Resolution order (cached at first evaluation, run once per process):
//   1. $AGIM_HOME env var — explicit override (also accepts the
//      legacy $IMHUB_HOME spelling).
//   2. `~/.agim/` if it already exists (v1.0+ canonical name)
//   3. `~/.im-hub/` if it exists (legacy from pre-v1.0 installs).
//   4. Default to `~/.agim/` (a fresh install will create it under
//      this name lazily as files are written).
//
// The same logic applies to the workspaces sibling: prefer
// `~/.agim-workspaces/`, fall back to `~/.im-hub-workspaces/`.
//
// Code in the rest of the codebase should import AGIM_HOME and
// AGIM_WORKSPACES from here rather than hard-coding `.im-hub`. The
// `cli-ui/paths.ts` helpers re-export from this module for
// backwards-compat with existing import sites.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function resolveAgimHome(): string {
  const override = process.env.AGIM_HOME || process.env.IMHUB_HOME
  if (override) return override
  const home = homedir()
  const newPath = join(home, '.agim')
  const oldPath = join(home, '.im-hub')
  if (existsSync(newPath)) return newPath
  if (existsSync(oldPath)) return oldPath
  return newPath
}

function resolveAgimWorkspaces(): string {
  const override = process.env.AGIM_WORKSPACES || process.env.IMHUB_WORKSPACES
  if (override) return override
  const home = homedir()
  const newPath = join(home, '.agim-workspaces')
  const oldPath = join(home, '.im-hub-workspaces')
  if (existsSync(newPath)) return newPath
  if (existsSync(oldPath)) return oldPath
  return newPath
}

/** Per-user state directory. Cached at module-eval time. */
export const AGIM_HOME: string = resolveAgimHome()

/** Per-agent workspace tree. Cached at module-eval time. */
export const AGIM_WORKSPACES: string = resolveAgimWorkspaces()

/** True iff the resolved AGIM_HOME is the legacy `~/.im-hub/` path.
 *  Useful for callers that want to log the legacy mode or emit a one-time
 *  "consider migrating to ~/.agim/" hint (we deliberately don't do that
 *  hint automatically — users can move when they want). */
export function isLegacyHome(): boolean {
  return AGIM_HOME.endsWith('/.im-hub')
}
