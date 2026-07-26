// One-shot install/upgrade cleanup for retired ACP residue.
//
// ACP (inbound :9090 + outbound remote agents) is gone. Older installs may
// still have acpPort/acpAgents in ~/.agim/config.json or AGIM_ACP_BIND in
// ~/.agim/env. Strip those so doctor/go/start no longer surface dead knobs.

import { hasRetiredAcpKeys, stripRetiredAcpKeys } from '../core/config-schema.js'
import { readConfigObject, writeConfigObject } from '../core/config-store.js'
import { readEnvFile, unsetEnvKey } from './env-file.js'

export interface AcpResiduePurgeResult {
  configKeysRemoved: string[]
  envKeysRemoved: string[]
}

const RETIRED_ENV_KEYS = ['AGIM_ACP_BIND', 'AGIM_ENABLE_REMOTE_AGENT'] as const

/**
 * Best-effort: rewrite config.json / env without retired ACP keys.
 * Safe to call on every start/go/doctor — no-op when nothing to purge.
 */
export async function purgeRetiredAcpResidue(): Promise<AcpResiduePurgeResult> {
  const result: AcpResiduePurgeResult = {
    configKeysRemoved: [],
    envKeysRemoved: [],
  }

  try {
    const current = await readConfigObject()
    if (hasRetiredAcpKeys(current)) {
      for (const key of ['acpAgents', 'acpDiscoveryUrls', 'acpPort'] as const) {
        if (Object.prototype.hasOwnProperty.call(current, key)) {
          result.configKeysRemoved.push(key)
        }
      }
      await writeConfigObject(stripRetiredAcpKeys(current) as Record<string, unknown>)
    }
  } catch {
    // Missing/unreadable config is fine — first-run will create a clean one.
  }

  try {
    const env = readEnvFile()
    for (const key of RETIRED_ENV_KEYS) {
      if (Object.prototype.hasOwnProperty.call(env, key)) {
        unsetEnvKey(key)
        result.envKeysRemoved.push(key)
      }
    }
  } catch {
    // Env file may be absent or read-only in some test harnesses.
  }

  return result
}
