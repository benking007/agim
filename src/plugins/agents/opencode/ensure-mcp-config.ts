// ensure-mcp-config.ts — register the agim MCP sidecar into opencode's
// global config so the reminder tools are visible to opencode runs.
//
// Why modify global config:
//
//   opencode loads MCP servers from `~/.config/opencode/opencode.json` at
//   startup and inherits parent process env when spawning each server's
//   stdio. We can't just "pass --mcp-config" per spawn — opencode has no
//   such flag. The next-best knob is the global config file.
//
// We do an additive update: read the JSON if it exists, set
// `mcp.agim.{type,command,enabled}`, write back. Other keys (provider,
// theme, etc.) are preserved unchanged. Idempotent — repeated calls are
// no-ops once the desired entry is in place.
//
// Per-spawn IM context (which thread / user is calling) flows through
// process.env: opencode-stdio-adapter sets AGIM_APPROVAL_SOCK +
// AGIM_RUN_ID on each spawn, opencode forwards them to the MCP server
// (per opencode/src/mcp/index.ts:384, env: { ...process.env, ... }).

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'opencode-mcp-config' })

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// Sidecar lives next to claude-code's MCP entry — same JS, opencode just
// reaches it through a different MCP transport.
const SIDECAR_PATH = join(__dirname, '..', 'claude-code', 'mcp-approval-server.js')

interface OpencodeMcpLocalEntry {
  type: 'local'
  command: string[]
  enabled?: boolean
}

interface OpencodeConfig {
  mcp?: Record<string, unknown>
  [k: string]: unknown
}

/**
 * Idempotently register the agim MCP server in opencode's global config.
 * Returns true when a write actually happened (config changed), false when
 * the config was already in the desired state.
 *
 * Failures (file unreadable, JSON malformed, write rejected) are logged
 * and swallowed — opencode users still keep working without reminder
 * tools, the same way they did before this feature.
 */
export async function ensureOpencodeMcpRegistered(): Promise<boolean> {
  const configPath = process.env.OPENCODE_CONFIG_PATH
    ?? join(homedir(), '.config', 'opencode', 'opencode.json')

  let config: OpencodeConfig = {}
  try {
    const buf = await readFile(configPath, 'utf8')
    config = JSON.parse(buf) as OpencodeConfig
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
      log.warn({ event: 'opencode.mcp.bad_config', configPath },
        'opencode config is not a JSON object — skipping MCP registration')
      return false
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      log.warn({
        event: 'opencode.mcp.read_failed', configPath,
        err: err instanceof Error ? err.message : String(err),
      }, 'opencode config read failed — skipping MCP registration')
      return false
    }
    // No config yet — start fresh.
    config = {}
  }

  if (!config.mcp || typeof config.mcp !== 'object' || Array.isArray(config.mcp)) {
    config.mcp = {}
  }
  const mcp = config.mcp as Record<string, unknown>

  const desired: OpencodeMcpLocalEntry = {
    type: 'local',
    command: [process.execPath, SIDECAR_PATH],
    enabled: true,
  }

  // Compare existing entry; bail if already correct.
  const existing = mcp.agim
  if (
    existing
    && typeof existing === 'object'
    && !Array.isArray(existing)
    && JSON.stringify(existing) === JSON.stringify(desired)
  ) {
    log.debug({ event: 'opencode.mcp.already_registered', configPath })
    return false
  }

  mcp.agim = desired

  try {
    await mkdir(dirname(configPath), { recursive: true })
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    log.info({
      event: 'opencode.mcp.registered',
      configPath, sidecar: SIDECAR_PATH,
    }, 'agim MCP server registered in opencode global config')
    return true
  } catch (err) {
    log.warn({
      event: 'opencode.mcp.write_failed', configPath,
      err: err instanceof Error ? err.message : String(err),
    }, 'opencode config write failed — opencode will not see agim MCP tools')
    return false
  }
}
