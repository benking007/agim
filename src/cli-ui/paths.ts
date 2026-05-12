// cli-ui/paths.ts — shared filesystem locations used by the CLI wizard
// + service management. Delegates to `core/agim-paths.ts`, which
// auto-detects whether the on-disk root is the v1.0+ `~/.agim/` name or
// the legacy `~/.im-hub/` name from a 0.x install. Existing imports keep
// working — the constant names didn't change.

import { join } from 'node:path'
import { AGIM_HOME, AGIM_WORKSPACES } from '../core/agim-paths.js'

export const CONFIG_DIR = AGIM_HOME
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
export const WORKSPACES_DIR = AGIM_WORKSPACES
