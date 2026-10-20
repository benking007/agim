// Bridge on/off switch.
//
// The admin page writes `bridgeEnabled` into ~/.agim/config.json. That
// value survives restart and applies in this process immediately.
// AGIM_BRIDGE_ENABLED is only an optional override: explicit off forces
// the bridge closed, explicit on keeps old machines working. Unset means
// the config file decides, and the default is off.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGIM_HOME } from './agim-paths.js'
import { updateConfigObject } from './config-store.js'

const ON = new Set(['1', 'true', 'on', 'yes'])
const OFF = new Set(['0', 'false', 'off', 'no'])

function configPath(): string {
  return join(process.env.AGIM_HOME || AGIM_HOME, 'config.json')
}

export function bridgeEnvOverride(): 'on' | 'off' | null {
  const raw = (process.env.AGIM_BRIDGE_ENABLED ?? '').trim().toLowerCase()
  if (!raw) return null
  if (OFF.has(raw)) return 'off'
  if (ON.has(raw)) return 'on'
  return null
}

export function readBridgeEnabledFlag(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8')) as { bridgeEnabled?: unknown }
    return parsed?.bridgeEnabled === true
  } catch {
    return false
  }
}

export function isBridgeEnabled(): boolean {
  const override = bridgeEnvOverride()
  if (override === 'off') return false
  if (override === 'on') return true
  return readBridgeEnabledFlag()
}

/** Persist the admin switch and return whether the bridge is actually open. */
export async function setBridgeEnabled(enabled: boolean): Promise<boolean> {
  await updateConfigObject((current) => ({
    config: { ...current, bridgeEnabled: enabled },
    result: enabled,
  }), { filePath: configPath() })
  if (isBridgeEnabled()) {
    const { resumePendingBridgeRuns } = await import('./bridge-run.js')
    const { startBridgeCallbackWorker } = await import('./bridge-callback.js')
    resumePendingBridgeRuns()
    startBridgeCallbackWorker()
  }
  return isBridgeEnabled()
}
