// cli-ui/paths.ts — shared filesystem locations used by the CLI wizard
// + service management. Mirrors the constants in cli.ts and onboarding.ts
// so callers don't have to import three different modules to get them.

import { homedir } from 'node:os'
import { join } from 'node:path'

export const CONFIG_DIR = join(homedir(), '.im-hub')
export const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
export const WORKSPACES_DIR = join(homedir(), '.im-hub-workspaces')
