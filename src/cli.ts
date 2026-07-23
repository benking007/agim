#!/usr/bin/env node
// Agim (阿吉姆) CLI.
//
// Brand: "Agim" (English) / "阿吉姆" (Chinese). Public runtime surfaces use
// the `agim` binary, `~/.agim/` state, `~/.agim-workspaces/` workspaces,
// `AGIM_*` env vars, `X-Agim-Token` headers, and `agim.service`.

import { program } from 'commander'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { registry } from './core/registry.js'
import { loadConfig as loadOnboardingConfig } from './core/onboarding.js'

const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')

function readPackageVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')) as { version?: unknown }
    if (typeof parsed.version === 'string' && parsed.version.trim()) {
      return parsed.version
    }
  } catch {
    // Keep --help/--version usable even in unusual source-tree layouts.
  }
  return '0.0.0'
}

program
  .name('agim')
  .description('Universal messenger-to-agent bridge')
  .version(readPackageVersion())
  .addHelpText('afterAll', `
Common path:
  agim go          First run: choose/configure one agent and start Web
  agim web         Find the Web console URL, service state, and token hint
  agim web --open  Open the Web console in your default browser
  agim web --start --open
                   Start the background service and open Web
  agim config      Continue setup: Agent, IM, Web port, admins, SMTP
  agim doctor      Explain local readiness problems

Service:
  agim start --bg  Run Agim in the background
  agim status      Show runtime state
  agim restart     Restart after config changes
  agim stop        Stop the service

Advanced:
  agim setup llm|mcp
  agim diag llm|mcp
`)

program
  .command('start')
  .description('Start the Agim runtime; use --bg for the normal background service')
  .option('--bg, --background', 'Start as a detached background daemon (writes pid file + log to ~/.agim/)')
  .action(async (opts: { bg?: boolean; background?: boolean }) => {
    // v1.2.85 — load ~/.agim/env into process.env BEFORE any branch
    // takes us elsewhere. systemd handles this via the unit's
    // `EnvironmentFile=-/root/.agim/env`, but macOS / brew / nvm /
    // pm2 installs have no such hook and rely on this explicit
    // load. Without it, operator edits to ~/.agim/env never reach
    // the running daemon, even after "restart" — they kept changing
    // settings, restarting, and seeing no effect. File values
    // fill blanks only; anything already set by the shell or
    // systemd takes precedence so we don't accidentally undo a
    // unit-file `Environment=` override.
    try {
      const { readEnvFile } = await import('./cli-ui/env-file.js')
      const f = readEnvFile()
      for (const [k, v] of Object.entries(f)) {
        if (process.env[k] === undefined) process.env[k] = v
      }
    } catch { /* best-effort — daemon still starts with whatever it has */ }

    // `--bg` (or its alias `--background`): hand off to the bg-spawner.
    // It re-execs us with `start` (no flag) inside a detached child so
    // the actual foreground start logic below runs in that child.
    if (opts.bg || opts.background) {
      const { cmdStart } = await import('./cli-ui/cmd-handlers.js')
      await cmdStart(true, async () => { /* unreachable in --bg path */ })
      return
    }

    const { runStartForeground } = await import('./cli/start-runtime.js')
    await runStartForeground()
  })


program
  .command('config [component]')
  .description('Unified config wizard; optional shortcuts jump to a section, e.g. `config wechat`')
  .action(async (component?: string) => {
    const { pickLang } = await import('./cli-ui/lang-picker.js')
    const { runConfigWizard, sectionForConfigComponent } = await import('./cli-ui/config-wizard.js')
    const { t: cliT } = await import('./cli-ui/i18n.js')
    const lang = await pickLang()
    if (!component) {
      await runConfigWizard(lang)
      return
    }
    const section = sectionForConfigComponent(component)
    if (!section) {
      console.log(cliT(lang, 'config.shortcut.unknown', { component }))
      process.exitCode = 1
      return
    }
    await runConfigWizard(lang, {
      initialSection: section,
      initialOnly: true,
      shortcutLabel: component,
    })
    return
  })

program
  .command('tui')
  .description('Open the terminal chat UI for local agent conversations')
  .option('-a, --agent <name>', 'Pre-select an agent by name (e.g. claude-code, codex, qoder, pi, native)')
  .option('-r, --resume [id]', 'Resume a saved session by id; "last" or empty picks the most recent')
  .option('--list-sessions', 'Print saved TUI sessions (latest first) and exit')
  .action(async (opts: { agent?: string; resume?: string | true; listSessions?: boolean }) => {
    const { runTui } = await import('./cli-ui/tui/index.js')
    // commander gives `--resume` (no arg) as `true`; normalise to empty string
    const resume = opts.resume === true ? '' : opts.resume
    await runTui({ agent: opts.agent, resume, listSessions: opts.listSessions })
  })

program
  .command('go')
  .description('First run: configure one agent, start Web, then continue in `agim web`')
  .action(async () => {
    const { runQuickstart } = await import('./cli-ui/quickstart.js')
    await runQuickstart()
  })

program.addCommand(
  program.createCommand('quickstart')
    .description('Compatibility alias for `agim go`')
    .action(async () => {
      const { runQuickstart } = await import('./cli-ui/quickstart.js')
      await runQuickstart()
    }),
  { hidden: true },
)

program
  .command('doctor')
  .description('Run a local readiness check and suggest the next command')
  .action(async () => {
    const { runDoctor } = await import('./cli-ui/doctor.js')
    const code = await runDoctor()
    if (code !== 0) process.exit(code)
  })

program
  .command('agents', { hidden: true })
  .description('List available agents')
  .action(async () => {
    await registry.loadBuiltInPlugins()
    const config = await loadOnboardingConfig()
    if (config.acpAgents?.length) {
      await registry.loadACPAgents(config.acpAgents)
    }
    const agents = registry.listAgents()
    if (agents.length === 0) {
      console.log('No agents registered yet.')
      console.log('Run "agim config claude" to configure Claude Code.')
      console.log('Run "agim config agent" to add a remote ACP agent.')
      return
    }

    console.log('🤖 Checking agents...\n')

    // Check all agents in parallel to avoid slow sequential timeouts
    const results = await Promise.allSettled(
      agents.map(async (name) => {
        const agent = registry.getAgent(name)
        const available = await agent?.isAvailable().catch(() => false)

        // Check if this is an ACP agent with extra info
        let info = ''
        try {
          const { ACPAdapter } = await import('./plugins/agents/acp/acp-adapter.js')
          if (agent instanceof ACPAdapter) {
            const manifest = await agent.getManifest().catch(() => undefined)
            if (manifest) {
              info = ` — ${manifest.description || 'Remote ACP agent'}`
            }
          }
        } catch { /* not an ACP agent */ }

        return { name, available, aliases: agent?.aliases || [], info }
      })
    )

    for (const result of results) {
      if (result.status === 'fulfilled') {
        const { name, available, aliases, info } = result.value
        const aliasStr = aliases.length ? ` (${aliases.join(', ')})` : ''
        console.log(`  ${available ? '✅' : '❌'} ${name}${aliasStr}${info}`)
      }
    }
  })

program
  .command('messengers', { hidden: true })
  .description('List available messengers')
  .action(async () => {
    await registry.loadBuiltInPlugins()
    const messengers = registry.listMessengers()
    if (messengers.length === 0) {
      console.log('No messengers registered yet.')
      console.log('Run "agim config wechat" to configure WeChat.')
      return
    }
    console.log('📱 Available Messengers:\n')
    for (const name of messengers) {
      console.log(`  ${name}`)
    }
  })

// ─── setup / diag helpers (native LLM + MCP) ────────────────────────────
// Keep these as first-class commands so docs + CLI stay aligned:
//   agim setup llm ...
//   agim setup mcp ...
//   agim diag llm
//   agim diag mcp

const setupCmd = program
  .command('setup')
  .description('Advanced setup helpers for LLM backends and MCP servers')

setupCmd
  .command('llm [args...]')
  .description('Manage Agim Agent model API backends')
  .action(async (args: string[] = []) => {
    const { runSetupLlm } = await import('./cli-ui/setup-llm.js')
    const code = await runSetupLlm(args)
    if (code !== 0) process.exit(code)
  })

setupCmd
  .command('mcp [args...]')
  .description('Manage MCP server configuration')
  .action(async (args: string[] = []) => {
    const { runSetupMcp } = await import('./cli-ui/setup-mcp.js')
    const code = await runSetupMcp(args)
    if (code !== 0) process.exit(code)
  })

const diagCmd = program
  .command('diag')
  .description('Advanced diagnostics for configured LLM/MCP backends')

diagCmd
  .command('llm')
  .description('Diagnose configured LLM backends')
  .action(async () => {
    const { runDiagLlm } = await import('./cli-ui/diag.js')
    const code = await runDiagLlm()
    if (code !== 0) process.exit(code)
  })

diagCmd
  .command('mcp')
  .description('Diagnose configured MCP servers')
  .action(async () => {
    const { runDiagMcp } = await import('./cli-ui/diag.js')
    const code = await runDiagMcp()
    if (code !== 0) process.exit(code)
  })

// ─── service-management commands (v0.5.0) ──────────────────────────────
// status / restart / stop / uninstall — all delegate to cli-ui/cmd-handlers.ts.

program
  .command('status')
  .description('Show whether Agim is running and where the Web console is')
  .action(async () => {
    const { cmdStatus } = await import('./cli-ui/cmd-handlers.js')
    cmdStatus()
  })

program
  .command('restart')
  .description('Restart the bridge (autodetects systemd vs background daemon)')
  .action(async () => {
    const { cmdRestart } = await import('./cli-ui/cmd-handlers.js')
    await cmdRestart()
  })

program
  .command('stop')
  .description('Stop the bridge (systemd unit or background daemon)')
  .action(async () => {
    const { cmdStop } = await import('./cli-ui/cmd-handlers.js')
    await cmdStop()
  })

program
  .command('uninstall')
  .description('Stop service, remove npm install + config; keeps ~/.agim-workspaces/')
  .action(async () => {
    const { cmdUninstall } = await import('./cli-ui/cmd-handlers.js')
    await cmdUninstall()
  })

// ─── access tokens for the web console (v1.1.10+) ───────────────────
//
// Generates / lists / revokes tokens stored under ~/.agim/tokens.json.
// Required to log into the web UI when bound to a non-loopback address.
// See src/core/access-token.ts for storage details + bootstrap behavior.

const tokenCmd = program.command('token').description('Manage web console access tokens')

tokenCmd
  .command('create [label]')
  .description('Create a new web access token (raw value printed once)')
  .action(async (label?: string) => {
    const { createToken } = await import('./core/access-token.js')
    const row = createToken(label || '')
    const { resolveCliLang, t: cliT } = await import('./cli-ui/i18n.js')
    const lang = resolveCliLang()
    console.log('')
    console.log(`✓ ${cliT(lang, 'token.cli.create_ok')}`)
    console.log(`   id    : ${row.id}`)
    console.log(`   label : ${label || cliT(lang, 'token.cli.unlabeled')}`)
    console.log(`   token : ${row.raw}`)
    console.log('')
    console.log(`⚠️ ${cliT(lang, 'token.cli.create_warn')}`)
    console.log(`   ${cliT(lang, 'token.cli.create_usage')}`)
  })

tokenCmd
  .command('list')
  .description('List existing tokens (no secrets shown)')
  .action(async () => {
    const { listTokens, getTokensFilePath } = await import('./core/access-token.js')
    const rows = listTokens()
    const { resolveCliLang, t: cliT } = await import('./cli-ui/i18n.js')
    const lang = resolveCliLang()
    console.log(cliT(lang, 'token.cli.list_path', { file: getTokensFilePath() }))
    if (rows.length === 0) {
      console.log(cliT(lang, 'token.cli.list_empty'))
      return
    }
    for (const r of rows) {
      const created = new Date(r.created_at * 1000).toISOString().replace('T', ' ').slice(0, 19)
      const lastUsed = r.last_used_at
        ? new Date(r.last_used_at * 1000).toISOString().replace('T', ' ').slice(0, 19)
        : cliT(lang, 'token.cli.never')
      console.log(`  ${r.id}  label=${r.label}  created=${created}  last_used=${lastUsed}`)
    }
  })

tokenCmd
  .command('revoke <id>')
  .description('Revoke (delete) a token by id')
  .action(async (id: string) => {
    const { revokeToken } = await import('./core/access-token.js')
    const ok = revokeToken(id)
    const { resolveCliLang, t: cliT } = await import('./cli-ui/i18n.js')
    const lang = resolveCliLang()
    if (ok) console.log(`✓ ${cliT(lang, 'token.cli.revoke_ok', { id })}`)
    else { console.log(`✗ ${cliT(lang, 'token.cli.revoke_missing', { id })}`); process.exit(1) }
  })

tokenCmd
  .command('bootstrap')
  .description('Print the one-time web bootstrap token (first boot only; consumes ~/.agim/web-bootstrap-token)')
  .action(async () => {
    const {
      retrieveWebBootstrapTokenRaw,
      getWebBootstrapTokenFile,
      hasAnyToken,
    } = await import('./core/access-token.js')
    const { resolveCliLang, t: cliT } = await import('./cli-ui/i18n.js')
    const lang = resolveCliLang()
    const row = retrieveWebBootstrapTokenRaw()
    if (row) {
      console.log('')
      console.log(`✓ ${cliT(lang, 'token.bootstrap.ok_title')}`)
      console.log(`   id    : ${row.id}`)
      console.log(`   token : ${row.raw}`)
      console.log('')
      console.log(`⚠️ ${cliT(lang, 'token.bootstrap.save_warn')}`)
      console.log(`   ${cliT(lang, 'token.bootstrap.usage')}`)
      console.log('')
      return
    }
    console.log('')
    if (!hasAnyToken()) {
      console.log(`✗ ${cliT(lang, 'token.bootstrap.none')}`)
      console.log(`   ${cliT(lang, 'token.bootstrap.start_hint')}`)
      console.log('       agim token bootstrap')
    } else {
      console.log(`✗ ${cliT(lang, 'token.bootstrap.consumed')}`)
      console.log(`   ${cliT(lang, 'token.bootstrap.file_hint', { file: getWebBootstrapTokenFile() })}`)
      console.log(`   ${cliT(lang, 'token.bootstrap.create_hint')}`)
      console.log('       agim token create <label>')
    }
    console.log('')
    process.exit(1)
  })

// ─── IM admin registry helpers (v2 model) ────────────────────────────

const adminCmd = program.command('admin', { hidden: true }).description('Inspect IM admin assignments')

adminCmd
  .command('list')
  .description('List current IM admins')
  .action(async () => {
    const { listAdmins } = await import('./core/admin-allowlist.js')
    const rows = listAdmins()
    if (rows.length === 0) {
      console.log('(no IM admins configured — assign from Web: Settings → Admins)')
      return
    }
    console.log(`IM Admins (${rows.length}):`)
    for (const r of rows) console.log(`  ${r.platform}:${r.userId}`)
  })

adminCmd
  .command('known')
  .description('List IM users discovered from inbound messages')
  .action(async () => {
    const { listKnownImUsers } = await import('./core/admin-allowlist.js')
    const rows = listKnownImUsers()
    if (rows.length === 0) {
      console.log('(no IM users discovered yet — ask someone to send a message first)')
      return
    }
    console.log(`Known IM Users (${rows.length}):`)
    for (const r of rows) {
      console.log(`  ${r.platform}:${r.userId}  last_seen=${r.lastSeenAt}`)
    }
  })

// ─── `agim web` — print the web console URL ─────────────────────────
//
// Reads the same Viewer config the IM `/web` command uses, but resolves
// from env directly (no running daemon needed for the env / publicBaseUrl
// branch). Cloudflared URLs live in the daemon's memory — when the
// operator uses tunnel-mode but isn't running the daemon, we surface a
// hint to use IM `/web` instead.

program
  .command('web')
  .description('Show the web console URL, service state, and login hint')
  .option('--public', 'Print the public/reverse-proxy URL only')
  .option('--welcome', 'Append the first-run welcome flag to the local URL')
  .option('--open', 'Open the Web console in the default browser')
  .option('--start', 'Start Agim in the background first when it is not running')
  .action(async (opts: { public?: boolean; welcome?: boolean; open?: boolean; start?: boolean }) => {
    const { cmdWeb } = await import('./cli-ui/cmd-handlers.js')
    const code = await cmdWeb({
      public: opts.public,
      welcome: opts.welcome,
      open: opts.open,
      start: opts.start,
    })
    if (code !== 0) process.exit(code)
  })

// ─── bare `agim` → entry menu (v0.5.0+) ─────────────────────────────
// If the user invoked us with no args (just `agim`), drop them at
// the language picker + maintenance menu instead of dumping --help text.
//
// This is intentionally BEFORE program.parse() so the menu runs even
// though commander would otherwise fall through to its default no-command
// branch. We check process.argv length to detect "no subcommand passed".

async function maybeRunEntryMenu(): Promise<boolean> {
  // argv layout: [node, /path/to/cli.js, ...rest]. No subcommand = length 2.
  if (process.argv.length > 2) return false
  if (!process.stdin.isTTY) return false  // piped / non-interactive — fall back to commander's help
  const { runEntryMenu } = await import('./cli-ui/entry-menu.js')
  const { cmdStatus, cmdStart, cmdStop, cmdRestart, cmdUninstall, cmdWeb } = await import('./cli-ui/cmd-handlers.js')
  const { action, lang } = await runEntryMenu()
  switch (action.kind) {
    case 'quit':
      return true
    case 'quickstart': {
      const { runQuickstart } = await import('./cli-ui/quickstart.js')
      await runQuickstart(lang)
      return true
    }
    case 'doctor': {
      const { runDoctor } = await import('./cli-ui/doctor.js')
      const code = await runDoctor()
      if (code !== 0) process.exitCode = code
      return true
    }
    case 'status':
      cmdStatus()
      return true
    case 'web':
      await cmdWeb({ welcome: true, start: true, open: true })
      return true
    case 'config': {
      // Reuse the lang the user just picked in runEntryMenu — re-prompting
      // here was a v0.5.1 regression (user reported: "已经选过语言不要再问").
      const { runConfigWizard } = await import('./cli-ui/config-wizard.js')
      await runConfigWizard(lang)
      return true
    }
    case 'start':
      // For foreground start from the menu, re-exec ourselves with the
      // proper subcommand so commander's `start` action runs. Easier than
      // duplicating the start body.
      if (action.bg) {
        await cmdStart(true, async () => { /* unreachable */ })
      } else {
        // Re-exec in the same shell so Ctrl-C maps cleanly. Dynamic
        // `await import` works in ESM (require() doesn't).
        const { spawn } = await import('node:child_process')
        await cmdStart(false, () => new Promise<void>((resolve) => {
          const child = spawn(process.execPath, [process.argv[1], 'start'], { stdio: 'inherit' })
          child.on('exit', () => resolve())
        }))
      }
      return true
    case 'restart':
      await cmdRestart()
      return true
    case 'stop':
      await cmdStop()
      return true
    case 'token': {
      const { runTokenMenu } = await import('./cli-ui/token-menu.js')
      await runTokenMenu(lang)
      return true
    }
    case 'uninstall':
      await cmdUninstall()
      return true
  }
}

void maybeRunEntryMenu().then((handled) => {
  if (!handled) program.parse()
})
