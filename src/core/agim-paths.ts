// agim-paths.ts — resolve the per-user state directory + workspace tree.
//
// Resolution order (cached at first evaluation, run once per process):
//   1. $AGIM_HOME env var — explicit override.
//   2. `~/.agim/` if it already exists.
//   3. Default to `~/.agim/` (a fresh install will create it under
//      this name lazily as files are written).
//
// The same logic applies to the workspaces sibling:
// $AGIM_WORKSPACES, otherwise `~/.agim-workspaces/`.
//
// Code in the rest of the codebase should import AGIM_HOME and
// AGIM_WORKSPACES from here rather than hard-coding `.agim`. The
// `cli-ui/paths.ts` helpers re-export from this module for
// backwards-compat with existing import sites.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function resolveAgimHome(): string {
  const override = process.env.AGIM_HOME
  if (override) return override
  const home = homedir()
  const agimPath = join(home, '.agim')
  if (existsSync(agimPath)) return agimPath
  return agimPath
}

function resolveAgimWorkspaces(): string {
  const override = process.env.AGIM_WORKSPACES
  if (override) return override
  const home = homedir()
  const agimWorkspaces = join(home, '.agim-workspaces')
  if (existsSync(agimWorkspaces)) return agimWorkspaces
  return agimWorkspaces
}

/** Per-user state directory. Cached at module-eval time. */
export const AGIM_HOME: string = resolveAgimHome()

/** Per-agent workspace tree. Cached at module-eval time. */
export const AGIM_WORKSPACES: string = resolveAgimWorkspaces()

/** Compatibility shim for older call sites; Agim now has a single home mode. */
export function isLegacyHome(): boolean {
  return false
}
