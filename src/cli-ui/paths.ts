// cli-ui/paths.ts — shared filesystem locations used by the CLI wizard
// + service management. Delegates to `core/agim-paths.ts` so CLI and
// service code share the same AGIM_HOME / AGIM_WORKSPACES resolution.

import { join } from 'node:path'
import { AGIM_HOME, AGIM_WORKSPACES } from '../core/agim-paths.js'

export const CONFIG_DIR = AGIM_HOME
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
export const WORKSPACES_DIR = AGIM_WORKSPACES
