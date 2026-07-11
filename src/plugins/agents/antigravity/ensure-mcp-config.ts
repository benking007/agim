/**
 * Antigravity / agy MCP injector.
 *
 * `agy` auto-loads MCP servers declared in `~/.gemini/config/mcp_config.json`
 * — the same shape Claude Code, Gemini CLI, and many other MCP hosts use:
 *
 *   {
 *     "mcpServers": {
 *       "<name>": { "command": "...", "args": [...], "env": {...} }
 *     }
 *   }
 *
 * On adapter init we read-modify-write this file so the `agim` entry
 * is always pointed at the current approval-bus socket (which rotates
 * every agim restart — see core/approval-bus.ts:defaultSocketPath).
 * Other entries the operator already had stay untouched.
 *
 * Why a single shared config file (vs claude-code's per-spawn tmpdir):
 * agy has no `--mcp-config <path>` flag; the only way to wire MCP is
 * the global file. Concurrency-wise that's fine because the file just
 * tells agy which sidecar to launch — the sidecar itself is stateless
 * across runs (each run gets its own AGIM_RUN_ID via process env).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { logger as rootLogger } from '../../../core/logger.js'

const log = rootLogger.child({ component: 'agent.antigravity.mcp' })

/** Resolves to `${HOME}/.gemini/config/mcp_config.json`. Exported for tests
 *  that want to point this at a tmp dir instead of the real home. */
export function defaultMcpConfigPath(): string {
  return join(homedir(), '.gemini', 'config', 'mcp_config.json')
}

export interface McpServerSpec {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerSpec>
  // Anything else the operator put in the file is preserved verbatim
  // (some MCP hosts allow extras like `globalShortcuts`).
  [extra: string]: unknown
}

/**
 * Ensure `~/.gemini/config/mcp_config.json` has the agim MCP entry
 * pointing at the current approval-bus socket. Preserves any other
 * keys / mcpServers entries the operator already configured.
 *
 * Idempotent: safe to call on every adapter init or before every spawn.
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
        // Empty / corrupt file — agy itself logs `unexpected end of JSON
        // input` and proceeds without MCP, so rewriting from scratch is
        // safer than refusing to update.
        log.warn({ event: 'antigravity.mcp.parse_failed', filePath }, 'replacing unparseable mcp_config.json')
        current = {}
      }
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code !== 'ENOENT') throw err
    // First-time setup: create directory + start from empty
  }

  if (!current.mcpServers || typeof current.mcpServers !== 'object') {
    current.mcpServers = {}
  }
  const existing = current.mcpServers.agim
  // Skip write if nothing changed — avoids touching mtime on every send.
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
    log.info({ event: 'antigravity.mcp.config_written', filePath },
      'wrote agim MCP entry to agy global config')
  } catch (err) {
    log.warn({ event: 'antigravity.mcp.write_failed', filePath, err: String(err) },
      'could not write mcp_config.json — agy will run without agim MCP')
    throw err
  }
}

/**
 * Remove the agim MCP entry. Used by tests / uninstall flows; the
 * normal adapter path just overwrites with a fresh socket.
 */
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
