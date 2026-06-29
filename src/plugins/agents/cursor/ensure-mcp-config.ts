/**
 * Cursor MCP injector.
 *
 * `cursor-agent` auto-loads MCP servers declared in `~/.cursor/mcp.json`
 * (global) or `.cursor/mcp.json` (per-workspace). The shape matches the
 * Claude / Gemini / generic MCP-host convention:
 *
 *   {
 *     "mcpServers": {
 *       "<name>": { "command": "...", "args": [...], "env": {...} }
 *     }
 *   }
 *
 * On adapter init we read-modify-write the global file so the `agim`
 * entry always points at the live approval-bus socket (which rotates
 * every agim restart — see core/approval-bus.ts). Other entries the
 * operator already had stay untouched.
 *
 * Per-workspace .cursor/mcp.json is left untouched on purpose — that
 * file belongs to the project the operator opened cursor in, not agim.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'agent.cursor.mcp' })

/** Resolves to `${HOME}/.cursor/mcp.json`. Exported so tests can point
 *  at a tmp dir. */
export function defaultMcpConfigPath(): string {
  return join(homedir(), '.cursor', 'mcp.json')
}

export interface McpServerSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerSpec>
  [extra: string]: unknown
}

/**
 * Ensure `~/.cursor/mcp.json` has the agim MCP entry pointing at the
 * current approval-bus socket. Idempotent: safe to call on every
 * adapter init or before every spawn. Preserves any other keys /
 * mcpServers entries the operator already configured.
 */
export async function ensureAgimMcp(spec: McpServerSpec, opts: { path?: string } = {}): Promise<void> {
  const filePath = opts.path ?? defaultMcpConfigPath()
  let current: McpConfigFile = {}
  try {
    const raw = await readFile(filePath, 'utf8')
    if (raw.trim()) {
      try {
        current = JSON.parse(raw) as McpConfigFile
      } catch {
        log.warn({ event: 'cursor.mcp.parse_failed', filePath },
          'replacing unparseable mcp.json')
        current = {}
      }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') throw err
  }

  if (!current.mcpServers || typeof current.mcpServers !== 'object') {
    current.mcpServers = {}
  }
  const existing = current.mcpServers.agim
  if (existing
      && existing.command === spec.command
      && JSON.stringify(existing.args ?? []) === JSON.stringify(spec.args ?? [])
      && JSON.stringify(existing.env ?? {}) === JSON.stringify(spec.env ?? {})) {
    return
  }
  current.mcpServers.agim = spec
  try {
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, JSON.stringify(current, null, 2), 'utf8')
    log.info({ event: 'cursor.mcp.config_written', filePath },
      'wrote agim MCP entry to cursor global config')
  } catch (err) {
    log.warn({ event: 'cursor.mcp.write_failed', filePath, err: String(err) },
      'could not write cursor mcp.json — cursor will run without agim MCP')
    throw err
  }
}

/** Remove the agim MCP entry. Used by tests / uninstall flows. */
export async function removeAgimMcp(opts: { path?: string } = {}): Promise<void> {
  const filePath = opts.path ?? defaultMcpConfigPath()
  let current: McpConfigFile = {}
  try {
    const raw = await readFile(filePath, 'utf8')
    if (raw.trim()) current = JSON.parse(raw) as McpConfigFile
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return
    throw err
  }
  if (current.mcpServers && current.mcpServers.agim) {
    delete current.mcpServers.agim
    await writeFile(filePath, JSON.stringify(current, null, 2), 'utf8')
  }
}
