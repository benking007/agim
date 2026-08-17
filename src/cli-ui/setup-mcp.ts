// setup-mcp — interactive wizard for adding / removing external MCP
// servers (P3 symmetry follow-up to setup-llm).
//
// Same shape as setup-llm: subcommands list / add / remove / health
// / help. Validates through configSchema before touching disk so a
// typo (e.g. setting both `command` and `url`) is caught before the
// file is written. Symmetric with Stage 6's /api/mcp/* REST + the
// SPA panel — operator can pick whichever surface fits their flow.
//
// Invoked as `agim setup mcp [<subcommand>] [<name>]`.

import { createInterface } from 'node:readline'
import { configSchema } from '../core/config-schema.js'
import { readConfigObject, updateConfigObject } from '../core/config-store.js'

/** Common MCP server presets so the operator doesn't have to remember
 *  the full @modelcontextprotocol/server-* package names. Add new
 *  presets here as the ecosystem grows; '(custom)' is always last. */
interface ServerPreset {
  label: string
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  hint?: string
}

class SetupMcpConfigError extends Error {}

const PRESETS: ServerPreset[] = [
  {
    label: 'Filesystem (read/write a local dir; very common quick-start)',
    transport: 'stdio',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'],
    hint: 'Will prompt for the directory to expose.',
  },
  {
    label: 'Playwright (browser navigate/click/assert; needs Chromium via playwright install)',
    transport: 'stdio',
    command: 'npx', args: ['-y', '@playwright/mcp@latest'],
    hint: 'Run `npx playwright install chromium` once if browsers are missing.',
  },
  {
    label: 'GitHub (issues, PRs, code search; needs GITHUB_PERSONAL_ACCESS_TOKEN env)',
    transport: 'stdio',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
  },
  {
    label: 'Postgres (read-only SQL queries; needs DATABASE_URL)',
    transport: 'stdio',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'],
    hint: 'Will prompt for the DATABASE_URL.',
  },
  {
    label: 'Brave Search (BRAVE_API_KEY required)',
    transport: 'stdio',
    command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'],
  },
  {
    label: 'Custom HTTP / SSE endpoint',
    transport: 'http',
  },
  {
    label: 'Custom stdio command',
    transport: 'stdio',
  },
]

interface RawMcpServer {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}

interface RawConfig {
  mcpServers?: RawMcpServer[]
  [k: string]: unknown
}

// ─── Entry point ────────────────────────────────────────────────────

export async function runSetupMcp(argv: string[]): Promise<number> {
  const sub = (argv[0] || '').toLowerCase()
  try {
    if (sub === '' || sub === 'help' || sub === '-h' || sub === '--help') return showHelp()
    if (sub === 'list' || sub === 'ls') return await listAction()
    if (sub === 'add')                  return await addAction()
    if (sub === 'remove' || sub === 'rm') return await removeAction(argv[1])
    if (sub === 'health' || sub === 'ping') return await healthAction(argv[1])
    return showHelp(`unknown subcommand: ${sub}`)
  } catch (err) {
    process.stderr.write(`\n❌ wizard failed: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

function showHelp(error?: string): number {
  if (error) process.stderr.write(`${error}\n\n`)
  process.stdout.write(`
agim setup mcp — manage external MCP servers interactively.

Subcommands:
  list                  show configured MCP servers
  add                   add a new server (preset picker → name → command/url → save)
  remove [<name>]       remove a server (config.json mcpServers)
  health [<name>]       reload + probe one server (or all when name omitted)

Notes:
  · Server metadata lives in ~/.agim/config.json under "mcpServers".
  · Discovered tools are exposed to the native agent via the
    "mcp_<server>_<tool>" naming.
  · CLI agents have their OWN MCP configs (typically inside
    ~/.claude/.../mcp-config.json) — those are unaffected by this
    wizard. agim's mcpServers list is for the native agent loop.
`)
  return error ? 1 : 0
}

// ─── subcommands ────────────────────────────────────────────────────

async function listAction(): Promise<number> {
  const cfg = await readConfig()
  const servers = cfg.mcpServers ?? []
  if (servers.length === 0) {
    process.stdout.write('(no MCP servers configured — run `agim setup mcp add`)\n')
    return 0
  }
  process.stdout.write('\nConfigured MCP servers:\n')
  for (const s of servers) {
    const transport = s.command ? 'stdio'
      : s.url?.endsWith('/sse') ? 'SSE'
      : s.url ? 'http'
      : '-'
    const target = s.command
      ? `${s.command}${s.args ? ` ${s.args.join(' ')}` : ''}`
      : (s.url ?? '-')
    const enabled = s.enabled === false ? ' [disabled]' : ''
    process.stdout.write(`  · ${s.name} [${transport}]${enabled}  →  ${target}\n`)
  }
  return 0
}

async function addAction(): Promise<number> {
  const rl = readline()
  try {
    process.stdout.write('\n── agim setup mcp add ──\n')
    process.stdout.write('Pick a server preset:\n')
    PRESETS.forEach((p, i) => { process.stdout.write(`  ${i + 1}. ${p.label}\n`) })
    const choice = await ask(rl, `Choice [1-${PRESETS.length}]: `)
    const idx = parseInt(choice, 10) - 1
    if (!Number.isFinite(idx) || idx < 0 || idx >= PRESETS.length) {
      return cancel('not a valid choice')
    }
    const preset = PRESETS[idx]

    const defaultName = suggestServerName(preset)
    const name = (await ask(rl, `Server name [${defaultName}]: `)).trim() || defaultName
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      return cancel('name must match [A-Za-z0-9][A-Za-z0-9._-]*')
    }

    const server: RawMcpServer = { name }

    if (preset.transport === 'stdio') {
      // command + args (presets prefill; operator can override or extend)
      const cmdDefault = preset.command ?? ''
      const cmd = (await ask(rl, `Command${cmdDefault ? ` [${cmdDefault}]` : ''}: `)).trim() || cmdDefault
      if (!cmd) return cancel('empty command')
      server.command = cmd

      const baseArgs = preset.args ? preset.args.join(' ') : ''
      // The filesystem preset needs a directory tail; prompt the
      // operator if the preset is filesystem-ish.
      let argsHint = baseArgs
      if (preset.label.startsWith('Filesystem')) {
        const dir = (await ask(rl, 'Directory to expose to MCP (absolute path): ')).trim()
        if (!dir) return cancel('empty directory')
        argsHint = `${baseArgs}${baseArgs ? ' ' : ''}${dir}`.trim()
      } else if (preset.label.startsWith('Postgres')) {
        const url = (await ask(rl, 'DATABASE_URL: ', { silent: true })).trim()
        if (!url) return cancel('empty DATABASE_URL')
        argsHint = `${baseArgs}${baseArgs ? ' ' : ''}${url}`.trim()
      }
      const argsLine = (await ask(rl, `Args (space-separated)${argsHint ? ` [${argsHint}]` : ''}: `)).trim() || argsHint
      const argsArr = argsLine.split(/\s+/).filter(Boolean)
      if (argsArr.length > 0) server.args = argsArr
    } else {
      // http / SSE
      const url = (await ask(rl, 'URL (http(s)://...; suffix /sse for SSE transport): ')).trim()
      if (!url) return cancel('empty URL')
      server.url = url

      const headersJson = (await ask(rl, 'Headers as JSON (optional, e.g. {"Authorization":"Bearer ..."}): ')).trim()
      if (headersJson) {
        try {
          const parsed = JSON.parse(headersJson) as Record<string, string>
          server.headers = parsed
        } catch {
          return cancel('headers must be valid JSON')
        }
      }
    }

    try {
      await updateConfigObject((current) => {
        const cfg = current as RawConfig
        const existing = cfg.mcpServers ?? []
        if (existing.some((s) => s.name === name)) {
          throw new SetupMcpConfigError(
            `server "${name}" already exists — use \`agim setup mcp remove ${name}\` first`,
          )
        }
        const next = { ...cfg, mcpServers: [...existing, server] }
        const result = configSchema.safeParse(next)
        if (!result.success) {
          throw new SetupMcpConfigError(
            `config validation failed: ${result.error.issues.map((i) => i.message).join('; ')}`,
          )
        }
        return { config: next, result: undefined }
      }, {
        fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
      })
    } catch (err) {
      if (err instanceof SetupMcpConfigError) return cancel(err.message)
      throw err
    }
    process.stdout.write(`\n✅ Added MCP server "${name}".\n`)
    process.stdout.write(`(restart agim, or run \`agim setup mcp health ${name}\` to probe live connection)\n`)
    return 0
  } finally {
    rl.close()
  }
}

async function removeAction(maybeName?: string): Promise<number> {
  const cfg = await readConfig()
  const servers = cfg.mcpServers ?? []
  if (servers.length === 0) {
    process.stdout.write('(no MCP servers to remove)\n')
    return 0
  }
  let name = (maybeName ?? '').trim()
  if (!name) {
    const rl = readline()
    try {
      process.stdout.write('\nWhich server?\n')
      servers.forEach((s, i) => { process.stdout.write(`  ${i + 1}. ${s.name}\n`) })
      const choice = await ask(rl, `Choice [1-${servers.length}]: `)
      const idx = parseInt(choice, 10) - 1
      if (!Number.isFinite(idx) || idx < 0 || idx >= servers.length) return cancel('not a valid choice')
      name = servers[idx].name
    } finally { rl.close() }
  }
  try {
    await updateConfigObject((current) => {
      const latest = current as RawConfig
      const latestServers = latest.mcpServers ?? []
      const next = latestServers.filter((s) => s.name !== name)
      if (next.length === latestServers.length) {
        throw new SetupMcpConfigError(`no server named "${name}"`)
      }
      return { config: { ...latest, mcpServers: next }, result: undefined }
    }, {
      fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
    })
  } catch (err) {
    if (err instanceof SetupMcpConfigError) return cancel(err.message)
    throw err
  }
  process.stdout.write(`✅ Removed MCP server "${name}".\n`)
  return 0
}

async function healthAction(maybeName?: string): Promise<number> {
  // Delegates to runDiagMcp for the all-servers case; for one server
  // we lazy-import the registry directly to keep the report focused.
  const cfg = await readConfig()
  const servers = cfg.mcpServers ?? []
  if (servers.length === 0) {
    process.stdout.write('(no MCP servers configured)\n')
    return 0
  }
  if (!maybeName) {
    const { runDiagMcp } = await import('./diag.js')
    return await runDiagMcp()
  }
  const target = servers.find((s) => s.name === maybeName)
  if (!target) return cancel(`no server named "${maybeName}"`)
  const {
    loadFromConfig: loadMcp, connectAll, describeRegistry, closeAll,
  } = await import('../core/llm/mcp-registry.js')
  await loadMcp(cfg)
  try {
    await connectAll()
    const snap = describeRegistry()
    const row = snap.servers.find((r) => r.name === maybeName)
    if (!row) {
      process.stdout.write(`server "${maybeName}" not in registry after reload\n`)
      return 1
    }
    process.stdout.write(`\nServer: ${row.name}\n`)
    process.stdout.write(`Connected: ${row.connected ? 'yes' : 'no'}\n`)
    process.stdout.write(`Tools:     ${row.toolCount}\n`)
    if (row.error) process.stdout.write(`Error:     ${row.error}\n`)
    return row.connected ? 0 : 1
  } finally {
    try { await closeAll() } catch { /* ignore */ }
  }
}

// ─── helpers ────────────────────────────────────────────────────────

async function readConfig(): Promise<RawConfig> {
  return await readConfigObject<RawConfig>({
    fallback: { messengers: [], agents: [], defaultAgent: 'agim' },
  })
}

function suggestServerName(preset: ServerPreset): string {
  // 'Filesystem (read/write a local dir...)' → 'filesystem'
  const head = preset.label.split(/[\s(]/)[0]?.toLowerCase() ?? 'server'
  return head.replace(/[^a-z0-9-]/g, '')
}

function readline(): ReturnType<typeof createInterface> {
  return createInterface({ input: process.stdin, output: process.stdout })
}

interface AskOpts { silent?: boolean }

function ask(rl: ReturnType<typeof createInterface>, prompt: string, opts: AskOpts = {}): Promise<string> {
  if (!opts.silent || !process.stdin.isTTY || !process.stdout.isTTY) {
    return new Promise<string>((resolve) => rl.question(prompt, resolve))
  }

  type ReadlineWithMask = ReturnType<typeof createInterface> & {
    stdoutMuted?: boolean
    _writeToOutput?: (str: string) => void
    output: NodeJS.WritableStream
  }

  const maskedRl = rl as ReadlineWithMask
  const prevWrite = maskedRl._writeToOutput

  return new Promise<string>((resolve) => {
    maskedRl.stdoutMuted = true
    maskedRl._writeToOutput = function (this: ReadlineWithMask, text: string): void {
      if (!this.stdoutMuted) {
        if (typeof prevWrite === 'function') prevWrite.call(this, text)
        else this.output.write(text)
        return
      }
      if (text === '\n' || text === '\r' || text === '\r\n') {
        this.output.write(text)
        return
      }
      this.output.write('*')
    }

    process.stdout.write(prompt)
    rl.question('', (answer) => {
      maskedRl.stdoutMuted = false
      if (typeof prevWrite === 'function') maskedRl._writeToOutput = prevWrite
      else delete maskedRl._writeToOutput
      resolve(answer)
    })
  })
}

function cancel(reason: string): number {
  process.stdout.write(`\n✖ aborted: ${reason}\n`)
  return 1
}

// ─── test hooks ────────────────────────────────────────────────────

export const _internal = {
  suggestServerName,
  PRESETS,
}
