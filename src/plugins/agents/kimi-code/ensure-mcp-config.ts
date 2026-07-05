/**
 * Kimi Code MCP injector.
 *
 * Kimi Code loads MCP servers from `${KIMI_CODE_HOME:-~/.kimi-code}/mcp.json`.
 * The config shape follows the common MCP host convention:
 *
 *   {
 *     "mcpServers": {
 *       "agim": { "command": "...", "args": [...], "env": {...} }
 *     }
 *   }
 *
 * We keep operator-defined entries intact and only update the agim server so
 * it points at the current approval-bus socket, which rotates each agim start.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'agent.kimi-code.mcp' })

export function kimiCodeHome(): string {
  return process.env.KIMI_CODE_HOME || join(homedir(), '.kimi-code')
}

export function defaultMcpConfigPath(): string {
  return join(kimiCodeHome(), 'mcp.json')
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

export async function ensureAgimMcp(spec: McpServerSpec, opts: { path?: string } = {}): Promise<void> {
  const filePath = opts.path ?? defaultMcpConfigPath()
  let current: McpConfigFile = {}
  try {
    const raw = await readFile(filePath, 'utf8')
    if (raw.trim()) {
      try {
        current = JSON.parse(raw) as McpConfigFile
      } catch {
        log.warn({ event: 'kimi.mcp.parse_failed', filePath }, 'replacing unparseable mcp.json')
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
    log.info({ event: 'kimi.mcp.config_written', filePath },
      'wrote agim MCP entry to Kimi Code config')
  } catch (err) {
    log.warn({ event: 'kimi.mcp.write_failed', filePath, err: String(err) },
      'could not write Kimi Code mcp.json — kimi will run without agim MCP')
    throw err
  }
}

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
  if (current.mcpServers?.agim) {
    delete current.mcpServers.agim
    await writeFile(filePath, JSON.stringify(current, null, 2), 'utf8')
  }
}
