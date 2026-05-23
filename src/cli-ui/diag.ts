// diag — operator-facing self-check commands (P2).
//
//   agim diag llm   pings every configured llmBackend in serial,
//                   prints a table with provider / model / source /
//                   latency / sampleText.
//
//   agim diag mcp   reloads + reconnects every mcpServer, prints a
//                   table with transport / target / connected /
//                   toolCount.
//
// Both subcommands read config straight from ~/.agim/config.json + the
// per-backend secrets store, so they work against a running daemon OR
// a freshly-installed one (no live HTTP needed). Output is plain text
// — easy to grep, easy to pipe.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AGIM_HOME } from '../core/agim-paths.js'
import { describeSecretSource } from '../core/llm/secrets.js'

const CONFIG_FILE = join(AGIM_HOME, 'config.json')

interface RawConfig {
  llmBackends?: Array<{ name: string; provider: string; model: string; baseUrl?: string }>
  llmRoles?: Record<string, string>
  mcpServers?: Array<{ name: string; command?: string; args?: string[]; url?: string; enabled?: boolean }>
}

async function readConfig(): Promise<RawConfig> {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf-8')) as RawConfig
  } catch {
    return {}
  }
}

/** Pretty-print a table given header row + data rows. Right-pads each
 *  column to the widest value in that column. Plain ASCII; works in
 *  any terminal. */
function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  )
  const sep = widths.map((w) => '-'.repeat(w)).join('  ')
  const fmt = (r: string[]): string =>
    r.map((cell, i) => (cell ?? '').padEnd(widths[i] ?? 0)).join('  ')
  return [fmt(header), sep, ...rows.map(fmt)].join('\n')
}

// ─── diag llm ──────────────────────────────────────────────────────

export async function runDiagLlm(): Promise<number> {
  const cfg = await readConfig()
  const backends = cfg.llmBackends ?? []
  if (backends.length === 0) {
    process.stdout.write('(no LLM backends configured — run `agim setup llm add`)\n')
    return 0
  }
  // Lazy-import the LLM modules so this CLI subcommand starts fast.
  const { loadFromConfig, getProviderByName } = await import('../core/llm/registry.js')
  loadFromConfig(cfg)

  const rows: string[][] = []
  for (const b of backends) {
    const src = describeSecretSource(b.name)
    const provider = getProviderByName(b.name)
    if (!provider) {
      rows.push([b.name, b.provider, b.model, src.source, '-', `(no key: ${src.source})`])
      continue
    }
    const startedAt = Date.now()
    try {
      const r = await provider.chat(
        [{ role: 'user', content: 'ping' }],
        { timeoutMs: 10_000, maxTokens: 16 },
      )
      const ms = Date.now() - startedAt
      const tokens = `${r.usage.promptTokens}->${r.usage.completionTokens}`
      const sample = r.text.replace(/\s+/g, ' ').slice(0, 40)
      rows.push([b.name, b.provider, b.model, src.source, `${ms}ms ${tokens}`, sample])
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      rows.push([b.name, b.provider, b.model, src.source, 'ERR', msg.slice(0, 60)])
    }
  }

  process.stdout.write('\n')
  process.stdout.write(table(
    ['NAME', 'PROVIDER', 'MODEL', 'KEY', 'PING', 'SAMPLE / ERROR'],
    rows,
  ))
  process.stdout.write('\n')

  const roles = cfg.llmRoles ?? {}
  if (Object.keys(roles).length > 0) {
    process.stdout.write('\nRole bindings:\n')
    for (const [role, backend] of Object.entries(roles)) {
      process.stdout.write(`  ${role.padEnd(14)} -> ${backend}\n`)
    }
  } else {
    process.stdout.write('\n(no role bindings — `agim setup llm role` to bind)\n')
  }
  const failed = rows.filter((r) => r[4] === 'ERR').length
  return failed > 0 ? 1 : 0
}

// ─── diag mcp ──────────────────────────────────────────────────────

export async function runDiagMcp(): Promise<number> {
  const cfg = await readConfig()
  const servers = cfg.mcpServers ?? []
  if (servers.length === 0) {
    process.stdout.write('(no MCP servers configured)\n')
    return 0
  }
  const { loadFromConfig: loadMcp, connectAll, describeRegistry, closeAll } =
    await import('../core/llm/mcp-registry.js')
  loadMcp(cfg)
  try {
    const r = await connectAll()
    const snap = describeRegistry()
    const rows = snap.servers.map((s) => {
      const cfgRow = servers.find((x) => x.name === s.name)
      const transport = cfgRow?.command ? 'stdio'
        : cfgRow?.url?.endsWith('/sse') ? 'SSE'
        : cfgRow?.url ? 'http'
        : '-'
      const target = cfgRow?.command
        ? `${cfgRow.command}${cfgRow.args ? ` ${cfgRow.args.join(' ')}` : ''}`
        : (cfgRow?.url ?? '-')
      return [
        s.name, transport, target.slice(0, 50),
        s.connected ? 'yes' : 'no',
        String(s.toolCount),
        s.error ? s.error.slice(0, 50) : '',
      ]
    })
    process.stdout.write('\n')
    process.stdout.write(table(
      ['NAME', 'TRANSPORT', 'TARGET', 'CONNECTED', 'TOOLS', 'ERROR'],
      rows,
    ))
    process.stdout.write(`\n\nTotal tools across servers: ${snap.totalTools}\n`)
    if (r.ok.length > 0) {
      process.stdout.write(`Connected: ${r.ok.join(', ')}\n`)
    }
    if (Object.keys(r.failed).length > 0) {
      process.stdout.write(`Failed:    ${Object.keys(r.failed).join(', ')}\n`)
    }
    return Object.keys(r.failed).length > 0 ? 1 : 0
  } finally {
    // Always close — the diag subcommand isn't long-lived.
    try { await closeAll() } catch { /* ignore */ }
  }
}

// ─── test hooks ────────────────────────────────────────────────────

export const _internal = { table, readConfig }
