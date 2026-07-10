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
import { getDefaultAgent } from './core/live-config.js'
import { sessionManager } from './core/session.js'
import { runOnThread } from './core/thread-queue.js'
import { parseMessage, routeMessage, type RouteContext } from './core/router.js'
import type { MessageContext } from './core/types.js'
import { generateTraceId, createLogger, sanitizeUserText, logger as rootLogger } from './core/logger.js'
import { validateConfig } from './core/config-schema.js'
import { workspaceRegistry } from './core/workspace.js'
import { bootstrapAgentWorkspaces } from './core/agent-cwd.js'
import { approvalBus, threadKey } from './core/approval-bus.js'
import { install as installApprovalRouter, tryHandleApprovalReply, platformToMessengerName } from './core/approval-router.js'
import { tryConsumeReply as tryConsumePendingReminderReply } from './core/pending-reminder.js'
import { consumeLocationContext, formatLocationAnnotation } from './core/location-context.js'
import { tryDetectReminderIntent } from './core/remind-intent.js'
import { createReminder } from './core/reminders.js'
import { setReminderConfirmNotifier } from './core/reminder-rpc.js'
import { sink } from './core/message-sink.js'
import {
  createInlineJob, markJobRunning, markJobCompleted, markJobFailed, linkJobOutbox, updateJobAgent,
} from './core/job-board.js'
import {
  checkMessengerConfig,
  checkAgentAvailability,
  runMessengerOnboarding,
  formatMessengerStartError,
  loadConfig as loadOnboardingConfig,
  saveConfig as saveOnboardingConfig,
  type Config as OnboardingConfig,
} from './core/onboarding.js'
import { startWebServer } from './web/server.js'
import { startACPServer } from './core/acp-server.js'
import { AGIM_HOME } from './core/agim-paths.js'

const CONFIG_DIR = AGIM_HOME
const CONFIG_FILE = join(CONFIG_DIR, 'config.json')
const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')

type Config = OnboardingConfig

async function loadConfig(): Promise<Config> {
  return loadOnboardingConfig()
}

async function saveConfig(config: Config): Promise<void> {
  return saveOnboardingConfig(config)
}

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
    console.log('🚀 Starting Agim (阿吉姆)…')

    // Process-level rejection guard. Without it, a stray Promise reject
    // (typically an in-flight undici fetch torn down during graceful
    // shutdown — e.g. a long-running A2A → opencode call whose socket
    // gets closed when serve-manager.stop() kills opencode-serve)
    // crashes the entire Node process under Node 22+'s
    // `--unhandled-rejections=throw` default. agim was looping on
    // exit-code=1 + Restart=always 10s, which presents as recurring
    // "服务中断" to IM users. Catching the rejection here demotes it
    // to a warning so the rest of gracefulShutdown can finish cleanly.
    // We intentionally do not call process.exit — let the natural
    // shutdown path complete.
    let requestFatalShutdown: (() => void) | null = null
    let fatalExitScheduled = false
    const scheduleFatalExit = (): void => {
      if (fatalExitScheduled) return
      fatalExitScheduled = true
      process.exitCode = 1
      const tm = setTimeout(() => process.exit(1), 250)
      if (typeof tm.unref === 'function') tm.unref()
    }

    process.on('unhandledRejection', (reason) => {
      const err = reason instanceof Error
        ? { name: reason.name, message: reason.message, stack: reason.stack }
        : { message: String(reason) }
      rootLogger.warn({ event: 'process.unhandled_rejection', err },
        'unhandledRejection swallowed (would have crashed Node)')
    })
    process.on('uncaughtException', (err) => {
      rootLogger.error({
        event: 'process.uncaught_exception',
        err: { name: err.name, message: err.message, stack: err.stack },
      }, 'uncaughtException; shutting down with exit code 1')
      if (requestFatalShutdown) {
        requestFatalShutdown()
      } else {
        scheduleFatalExit()
      }
    })

    // R14 — pre-flight self-check. Two failure modes the operator
    // hit before this guard existed:
    //
    //   (a) An old agim from a botched restart still owns port 3000.
    //       systemd's TimeoutStopSec elapsed but cgroup-kill failed
    //       (dbus-run-session wrapper escaped the control group), so
    //       systemctl restart spawns a NEW agim that EADDRINUSE-loops.
    //       PID file detection catches the obvious case: if a pid
    //       file exists and points at a live process that is NOT us,
    //       exit immediately rather than racing the port bind.
    //
    //   (b) Operator runs `agim start` by hand on a host where systemd
    //       already manages agim. Two competing instances are nearly
    //       impossible to debug. Warn loudly + write a marker file so
    //       post-incident `journalctl -u agim` correlates with this
    //       run.
    try {
      const { PID_FILE } = await import('./cli-ui/service.js')
      const { existsSync: _exists, readFileSync: _read } = await import('node:fs')
      if (_exists(PID_FILE)) {
        const recorded = parseInt(_read(PID_FILE, 'utf-8').trim(), 10)
        if (Number.isFinite(recorded) && recorded > 0 && recorded !== process.pid) {
          // Is the recorded pid alive?
          let alive = false
          try { process.kill(recorded, 0); alive = true } catch { /* stale */ }
          if (alive) {
            console.error()
            console.error('🛑 Another agim process is already running:')
            console.error(`   pid:  ${recorded}`)
            console.error(`   file: ${PID_FILE}`)
            console.error()
            console.error('   If that pid is stale (process actually dead), remove the file and retry:')
            console.error(`     rm ${PID_FILE}`)
            console.error()
            console.error('   If systemd manages agim, prefer:')
            console.error('     systemctl restart agim.service')
            console.error()
            process.exit(2)
          }
        }
      }
    } catch { /* defensive — fall through to start if probe failed */ }
    // Soft warning: not inside systemd's cgroup but a unit file exists.
    // INVOCATION_ID is injected by systemd on every Exec*= so its
    // absence is a reliable "not under systemd" signal. We don't
    // refuse to start (the operator may be debugging foreground), but
    // we leave a journal-visible warn line + an anomaly marker.
    try {
      const inSystemd = typeof process.env.INVOCATION_ID === 'string' && process.env.INVOCATION_ID.length > 0
      if (!inSystemd) {
        const { existsSync: _exists2 } = await import('node:fs')
        const hasUnit = _exists2('/etc/systemd/system/agim.service')
        if (hasUnit) {
          console.warn()
          console.warn('⚠️  agim is starting OUTSIDE systemd, but a systemd unit exists on this host.')
          console.warn('   Two competing instances will fight for port 3000. If unintended:')
          console.warn('     systemctl start agim.service   # let systemd own this process')
          console.warn()
          try {
            const { writeFileSync: _write } = await import('node:fs')
            const { join: _join } = await import('node:path')
            const { AGIM_HOME: _home } = await import('./core/agim-paths.js')
            _write(_join(_home, 'start-anomaly.log'),
              `${new Date().toISOString()} agim started outside systemd while unit file exists (pid=${process.pid})\n`,
              { flag: 'a', mode: 0o600 })
          } catch { /* anomaly log is best-effort */ }
        }
      }
    } catch { /* defensive */ }

    // R15 — write our pid to PID_FILE now that the self-check has
    // passed. Pre-R15 this only happened when an `agim start --bg`
    // spawn went through spawnBackground; systemd-started agim never
    // wrote the file, so the next foreground `agim start` saw a stale
    // pid (or no pid at all) and the self-check silently passed
    // — defeating R14 §六 in the most common deployment shape.
    // Writing here means EVERY successful `agim start` (foreground or
    // systemd) maintains the file. gracefulShutdown unlinks it.
    try {
      const { PID_FILE: _pidFile } = await import('./cli-ui/service.js')
      const { writeFileSync: _writePid, chmodSync: _chmodPid } = await import('node:fs')
      _writePid(_pidFile, `${process.pid}\n`, { mode: 0o600 })
      try { _chmodPid(_pidFile, 0o600) } catch { /* non-POSIX */ }
    } catch (err) {
      // Failing to write the pidfile is non-fatal — self-check next
      // time will fall back to no-file. Log and continue.
      console.warn(`⚠️  Could not write PID file: ${err instanceof Error ? err.message : String(err)}`)
    }

    let config = await loadConfig()
    console.log(`Config loaded from ${CONFIG_FILE}`)

    // Validate config schema — always use the zod-validated output (which
    // applies defaults and strips invalid fields) instead of the raw config.
    const validation = validateConfig(config)
    if (!validation.ok) {
      console.warn('⚠️  Config schema issues detected:')
      for (const err of validation.errors) {
        console.warn(`   - ${err}`)
      }
      console.warn('   Agim will continue with defaults for invalid fields.\n')
    }
    const validatedConfig = validation.config
    config = validatedConfig as unknown as Config

    // v1.2.103 — publish the in-memory config to the live-config singleton
    // so registry filters + routeCtx + Web/ACP defaultAgent all see the same
    // values. PUT /api/config will republish on save, removing the need for
    // a service restart after toggling enabled agents / default agent in
    // the SPA.
    const { setLiveConfig } = await import('./core/live-config.js')
    setLiveConfig(config)

    // Initialize workspace registry
    const rawConfig = config as Record<string, unknown>
    const workspaces = rawConfig.workspaces as Array<Record<string, unknown>> | undefined
    workspaceRegistry.load({ workspaces: workspaces as Array<{ id: string; name: string; agents: string[]; members?: string[]; rateLimit?: { rate: number; intervalSec: number; burst: number } }> })
    const wsCount = workspaces?.length || 1
    console.log(`Workspaces loaded: ${wsCount} workspace(s)`)

    // Initialize session manager
    await sessionManager.start()

    // Start approval-bus before any agent can spawn — failure here is
    // non-fatal: claude-code falls back to legacy --permission-mode dontAsk.
    if (process.env.AGIM_APPROVAL_DISABLED === '1') {
      console.log('🛑 Approval bus disabled via AGIM_APPROVAL_DISABLED=1')
    } else {
      try {
        const sockPath = await approvalBus.start()
        console.log(`✅ Approval bus listening on ${sockPath}`)
        // R13 C1 — surface the timeout-default policy at startup so
        // operators don't forget `allow` is in effect.
        try {
          const { announceTimeoutDefaultIfAllow } = await import('./core/approval-bus.js')
          announceTimeoutDefaultIfAllow()
        } catch { /* best-effort */ }
        // Expose the path through env so long-lived child processes
        // (notably `opencode serve`, which spawns the MCP sidecar with
        // `env: process.env`) can connect without per-spawn config.
        // claude-code and opencode stdio still set this per-spawn via
        // extraEnv — that override wins inside their spawn scope.
        process.env.AGIM_APPROVAL_SOCK = sockPath
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`⚠️ Approval bus failed to start (${msg}); claude-code will fall back to dontAsk mode`)
      }
    }
    // Wire the bus's lifetime counters into /api/metrics (M14). Done even
    // when the bus failed to start — getMetrics() returns zeros, which is
    // the correct Prometheus snapshot for "no approvals processed".
    const { setApprovalBusSnapshotProvider } = await import('./core/metrics.js')
    setApprovalBusSnapshotProvider(() => approvalBus.getMetrics())

    // Load plugins FIRST (agents won't be registered until this runs)
    await registry.loadBuiltInPlugins()

    // Native LLM + MCP boot — populate the in-process registries from
    // config.json + ~/.agim/llm-secrets.json. Without this, `native`
    // isAvailable() is always false even when llmBackends are configured.
    try {
      const { resolveCliLang, t: cliT } = await import('./cli-ui/i18n.js')
      const bootLang = resolveCliLang()
      const { loadFromConfig: loadLlmFromConfig } = await import('./core/llm/registry.js')
      loadLlmFromConfig(validatedConfig)
      const { loadFromConfig: loadMcpFromConfig, connectAll } = await import('./core/llm/mcp-registry.js')
      await loadMcpFromConfig(validatedConfig as { mcpServers?: unknown })
      const mcpSummary = await connectAll()
      if (mcpSummary.ok.length > 0) {
        console.log(`✅ ${cliT(bootLang, 'start.mcp_connected', { servers: mcpSummary.ok.join(', '), toolCount: mcpSummary.toolCount })}`)
      }
      if (Object.keys(mcpSummary.failed).length > 0) {
        console.warn(`⚠️ ${cliT(bootLang, 'start.mcp_connect_failures', { failures: JSON.stringify(mcpSummary.failed) })}`)
      }
      const { describeNativeAgent } = await import('./plugins/agents/native/index.js')
      console.log(`🤖 ${cliT(bootLang, 'start.native_agent', { desc: describeNativeAgent() })}`)
    } catch (err) {
      const { resolveCliLang, t: cliT } = await import('./cli-ui/i18n.js')
      const bootLang = resolveCliLang()
      console.warn(`⚠️ ${cliT(bootLang, 'start.native_boot_failed', { message: err instanceof Error ? err.message : String(err) })}`)
    }

    // v1.2.97 — start the local RPC bridge so bgjob-spawned Python (or
    // any-language) scripts can call back into agim's tool surface via
    // a Unix socket. Best-effort: a failure logs at warn but doesn't
    // abort startup. Sub-scripts that try to use the bridge with no
    // server up will refuse to construct an RPC client at import time.
    try {
      const { startRpcServer } = await import('./core/llm/agim-rpc-server.js')
      const s = await startRpcServer()
      if (s) console.log('✅ Local RPC bridge ready (bgjob → agim memo/skill/push)')
    } catch (err) {
      console.warn('⚠️  agim RPC bridge failed to start:',
        err instanceof Error ? err.message : String(err))
    }

    // Bootstrap per-agent IM workspaces. Idempotent — creates
    // ~/.agim-workspaces/<agent>/ and seeds CLAUDE.md / AGENTS.md only if
    // they don't exist yet. See docs/architecture/agent-cwd-and-memory.md.
    try {
      const bootstrapped = await bootstrapAgentWorkspaces()
      const { resolveCliLang, t: cliT } = await import('./cli-ui/i18n.js')
      const bootLang = resolveCliLang()
      for (const { agent, dir } of bootstrapped) {
        console.log(`📁 ${cliT(bootLang, 'start.agent_workspace', { agent, dir })}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const { resolveCliLang, t: cliT } = await import('./cli-ui/i18n.js')
      const bootLang = resolveCliLang()
      console.warn(`⚠️ ${cliT(bootLang, 'start.workspace_boot_failed', { message: msg })}`)
      console.warn(`   ${cliT(bootLang, 'start.workspace_fallback')}`)
    }

    // Load ACP (remote) agents from config
    if (config.acpAgents?.length) {
      await registry.loadACPAgents(config.acpAgents)
    }

    // Discover ACP agents via .well-known/acp on configured base URLs
    const discoveryUrls = (config as { acpDiscoveryUrls?: string[] }).acpDiscoveryUrls
    if (discoveryUrls?.length) {
      await registry.loadDiscoveredACPAgents(discoveryUrls)
    }

    // Start the scheduler (runs cron-due schedules every 30s)
    const { startScheduler } = await import('./core/schedule.js')
    startScheduler()

    // Start the reminder engine (one-shot lightweight timers, 5s tick)
    const { startReminderEngine } = await import('./core/reminders.js')
    startReminderEngine()

    // Start the memo expiry sweeper (every 5 min — purges memos with
    // expires_at <= now). Idempotent: safe even if startSweepTimer is
    // called twice. Lazy import keeps memos.ts out of the cold-start path
    // until it's actually needed.
    const { startSweepTimer: startMemoSweep } = await import('./core/memos.js')
    startMemoSweep()

    // Startup diagnostic: IM admin registry summary (admins + known IM users).
    // The registry is now file-based and managed from Web Settings → Admins.
    try {
      const { logStartupResolution } = await import('./core/admin-allowlist.js')
      logStartupResolution()
    } catch { /* best-effort */ }

    // v1.2.66 — sender allowlist startup log. Emits OPEN_IM_ACCESS
    // warning when no list is configured (default-open mode).
    try {
      const { logStartupResolution: logSenderResolution } = await import('./core/sender-allowlist.js')
      logSenderResolution()
    } catch { /* best-effort */ }

    // v1.2.66 — root-user warning. Running agim as root means a
    // compromised tool call has root privileges. Most operators run
    // under systemd which defaults to running as root unless User=
    // is set in the unit file.
    try {
      const getUid = (process as unknown as { getuid?: () => number }).getuid
      if (typeof getUid === 'function' && getUid() === 0) {
        rootLogger.warn({
          event: 'startup.running_as_root',
          hint: 'consider creating a dedicated user + User=agim in the systemd unit',
        }, '⚠ Running as root (uid 0). Tool calls run with root privileges. Consider a dedicated user.')
      }
    } catch { /* getuid not available on Windows */ }

    // v1.2.66 — env file permission audit. ~/.agim/env holds API keys
    // + DB passwords. Wizard writes 0600 but if
    // the operator manually edited / scp'd it, the mode may have
    // drifted. WARN (not refuse-to-start) so a recovering operator
    // can still bring the service up.
    try {
      const { statSync } = await import('node:fs')
      const { ENV_FILE } = await import('./cli-ui/env-file.js')
      const st = statSync(ENV_FILE)
      // group-readable / world-readable bits set → warn
      const mode = st.mode & 0o777
      if (mode & 0o077) {
        rootLogger.warn({
          event: 'startup.env_file_perm_lax',
          file: ENV_FILE,
          mode: mode.toString(8),
          recommendedMode: '600',
          hint: `chmod 600 ${ENV_FILE}`,
        }, `⚠ env file mode ${mode.toString(8)} is too permissive (group/world bits set). Recommend chmod 600.`)
      }
    } catch { /* file missing → wizard hasn't run; not our problem */ }

    // ============================================
    // ONBOARDING CHECKS (before default fill!)
    // ============================================

    // Check messengers BEFORE the default fill
    const onboardingResult = checkMessengerConfig(config)
    if (onboardingResult.needsOnboarding) {
      if (process.stdin.isTTY) {
        // Interactive shell — run the picker.
        console.log('👋 No messengers configured.\n')
        const newConfig = await runMessengerOnboarding(config)
        if (!newConfig) {
          console.log('\n❌ Onboarding cancelled.')
          console.log('Run "agim config <messenger>" to configure manually.')
          process.exit(1)
        }
        config = newConfig
        await saveConfig(config)
      } else {
        // Non-interactive (systemd / launchctl / docker / bgjob). Don't try
        // to prompt and don't exit — web-console-only deployments are a
        // legitimate use case. Log a hint and keep going; web server + ACP
        // server + scheduler / reminders / memos / approval bus still start.
        console.log('ℹ️ No messengers configured — running in web-console-only mode.')
        console.log('   Configure later with: agim config <wechat|feishu|dingtalk>')
      }
    }

    // Check agents (async, AFTER plugins loaded)
    const agentResult = await checkAgentAvailability()
    if (agentResult.allMissing) {
      {
        const { resolveCliLang, t: cliT, formatAgentInstallHint: fmtHint } = await import('./cli-ui/i18n.js')
        const bootLang = resolveCliLang()
        console.log(`\n⚠️ ${cliT(bootLang, 'start.no_agents')}`)
        console.log(fmtHint(bootLang, agentResult.missing))
        console.log(`\n${cliT(bootLang, 'start.install_one_agent')}`)
      }
      process.exit(1)
    } else if (agentResult.missing.length > 0) {
      {
        const { resolveCliLang, t: cliT, formatAgentInstallHint: fmtHint } = await import('./cli-ui/i18n.js')
        const bootLang = resolveCliLang()
        console.log(`⚠️ ${cliT(bootLang, 'start.agents_unavailable', { missing: agentResult.missing.join(', ') })}`)
        console.log(`   ${fmtHint(bootLang, agentResult.missing)}`)
      }
      console.log('')
    }

    // Keep operator intent: only fall back when the configured default
    // is empty or currently unavailable. Overwriting on every boot made
    // default-agent selection appear "non-persistent" after restart.
    if (agentResult.available.length > 0) {
      const configuredDefault = config.defaultAgent
      if (!configuredDefault || !agentResult.available.includes(configuredDefault)) {
        config.defaultAgent = agentResult.available[0]
      }
    }

    // ============================================
    // START MESSENGERS
    // ============================================

    // Get messengers to start. Empty array is fine — web-console-only
    // deployments don't need any IM adapter.
    const messengersToStart = [...config.messengers]

    // Auto-include the email adapter so /remind email ... works without
    // explicit `agim config email`. The adapter's start() is fail-soft
    // when SMTP env vars are missing — it stays "registered but disabled"
    // and any actual send call throws a clear "not configured" error.
    if (!messengersToStart.includes('email')) {
      messengersToStart.push('email')
    }

    // Start messenger adapters
    try {
      const { setBootPhase } = await import('./core/boot-state.js')
      setBootPhase('messengers_loading')
    } catch { /* ignore */ }

    // Register the recovery-button executor. When a user taps "🔁 重发" on
    // a recovery card, job-recovery creates the replacement row + invokes
    // this callback to actually run the agent. Without this the button
    // creates an orphan inline-job that never executes.
    try {
      const { setRecoveryExecutor } = await import('./core/job-recovery.js')
      setRecoveryExecutor(async ({ entry, newJobId }) => {
        const synthCtx: MessageContext = {
          platform: entry.platform,
          channelId: entry.channelId,
          traceId: generateTraceId(),
          inlineJobId: newJobId,
          message: {
            id: `recovery-${newJobId}`,
            threadId: entry.threadId,
            userId: entry.creatorId,
            text: entry.prompt,
            timestamp: new Date(),
            channelId: entry.channelId,
          },
        }
        synthCtx.logger = createLogger({
          traceId: synthCtx.traceId, platform: entry.platform, component: 'cli',
        })
        synthCtx.logger.info({
          event: 'recovery.button.execute', newJobId, oldJobId: entry.jobId,
          agent: entry.agent, promptPreview: entry.prompt.substring(0, 80),
        })
        // Tell the user we're on it before the agent's (possibly slow) reply.
        try {
          await sink.deliver({
            platform: entry.platform, channelId: entry.channelId, threadId: entry.threadId,
            payload: '🔁 好的，重发中…', kind: 'text',
          })
        } catch { /* sink already queues — best-effort */ }
        await handleMessage(synthCtx, config.defaultAgent)
      })
    } catch (err) {
      console.warn('⚠️ failed to register recovery executor:', err)
    }

    for (const name of messengersToStart) {
      const messenger = registry.getMessenger(name)
      if (!messenger) {
        console.warn(`⚠️ Messenger "${name}" not found, skipping`)
        continue
      }

      // Set up message handler
      messenger.onMessage(async (ctx: MessageContext) => {
        const traceId = generateTraceId()
        ctx.traceId = traceId
        ctx.logger = createLogger({ traceId, platform: ctx.platform, component: 'cli' })
        ctx.logger.info({
          event: 'message.received',
          userId: ctx.message.userId,
          ...sanitizeUserText(ctx.message.text),
        })

        // v2 admin model — auto-discover IM identities. Any user who has
        // ever talked to agim appears in Web Settings → Admins as a candidate,
        // so operators never have to hand-type opaque user IDs.
        try {
          const { recordSeenImUser } = await import('./core/admin-allowlist.js')
          recordSeenImUser(ctx.platform, ctx.message.userId, {
            channelId: ctx.channelId,
            threadId: ctx.message.threadId,
          })
        } catch (err) {
          ctx.logger.warn({
            event: 'admin.known_user.record_failed',
            err: err instanceof Error ? err.message : String(err),
          }, 'failed to record known IM user; continuing')
        }

        // v1.2.66 — sender allowlist gate. When configured (env
        // AGIM_ALLOWED_USERS set), unknown senders get a short refusal
        // and the message is dropped before reaching any agent or
        // tool. When unconfigured, this passes through unchanged
        // (default-open; boot log warns OPEN_IM_ACCESS).
        try {
          const { isSenderAllowlistConfigured, isSenderAllowed, senderDenialMessage } =
            await import('./core/sender-allowlist.js')
          const configured = isSenderAllowlistConfigured()
          let allowed = true
          if (configured) {
            try {
              allowed = isSenderAllowed(ctx.platform, ctx.message.userId)
            } catch (err) {
              // v1.3.7 (F6) — a deny-gate must NOT fail open. If the
              // allowlist is configured but we can't evaluate it, treat the
              // sender as NOT allowed rather than silently letting them in.
              ctx.logger.error({
                event: 'sender.allowlist.eval_failed',
                platform: ctx.platform,
                err: err instanceof Error ? err.message : String(err),
              }, 'sender allowlist evaluation failed while configured — failing CLOSED (deny)')
              allowed = false
            }
          }
          if (configured && !allowed) {
            ctx.logger.warn({
              event: 'sender.allowlist.denied',
              platform: ctx.platform,
              userId: ctx.message.userId,
            }, 'message dropped — sender not on AGIM_ALLOWED_USERS')
            try {
              await sink.deliver({
                platform: ctx.platform,
                channelId: ctx.channelId,
                threadId: ctx.message.threadId,
                payload: senderDenialMessage(ctx.platform, ctx.message.userId),
                kind: 'text',
                priority: 'high',
                source: 'system',
              })
            } catch { /* best-effort */ }
            return
          }
        } catch (err) {
          // v1.3.7 (F6) — the module failed to load, so we genuinely cannot
          // tell whether a restriction is configured. Surface LOUDLY (was a
          // quiet fail-open warn). Open posture is preserved only because we
          // can't prove a restriction exists.
          ctx.logger.error({
            event: 'sender.allowlist.error',
            err: err instanceof Error ? err.message : String(err),
          }, 'sender allowlist module failed to load; cannot enforce — review AGIM_ALLOWED_USERS')
        }

        // Phase 3 — interrupted-job recovery reply. If the user has a
        // pending "retry / cancel" prompt outstanding on this thread AND
        // their reply parses as 1/重发/2/取消, consume the message here
        // before any other interceptor (approval / reminder) sees it.
        // hasPendingRecovery is a cheap map lookup; we only do the full
        // parse when the gate is true.
        const recoveryThreadKey = `${ctx.platform}:${ctx.channelId}:${ctx.message.threadId}`
        try {
          const { hasPendingRecovery, tryHandleRecoveryReply } =
            await import('./core/job-recovery.js')
          if (hasPendingRecovery(recoveryThreadKey)) {
            const outcome = tryHandleRecoveryReply(recoveryThreadKey, ctx.message.text)
            if (outcome.kind === 'retried') {
              ctx.logger.info({
                event: 'recovery.retried', oldJobId: outcome.oldJobId, newJobId: outcome.newJobId,
              })
              // Substitute the user's "1" with the original prompt so the
              // rest of the handler reruns the work. handleMessage reads
              // message.text again on its own, so this is the cheapest
              // way to re-enter the normal path without duplicating logic.
              ctx.message.text = outcome.entry.prompt
              // Hand the freshly-created replacement job id to handleMessage
              // so it doesn't build a second inline row (the recovery flow
              // already created newJobId + stamped replaced_by on the old
              // row). Without this we'd accumulate orphan 'pending' rows
              // that retention eventually GCs — visible but harmless.
              ctx.inlineJobId = outcome.newJobId
              // Send a short "好的，重发中..." acknowledgement first so the
              // user knows we accepted the choice (the actual agent reply
              // can take many seconds). priority=normal — slot it after
              // anything urgent in the outbox.
              await sink.deliver({
                platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
                payload: '🔁 好的，重发中…',
                kind: 'text',
              })
              // Fall through to the normal handler below with the rewritten
              // message text.
            } else if (outcome.kind === 'cancelled') {
              ctx.logger.info({ event: 'recovery.cancelled', oldJobId: outcome.oldJobId })
              await sink.deliver({
                platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
                payload: '✅ 已取消，不再处理上次的消息。',
                kind: 'text',
              })
              return
            }
            // outcome.kind === 'not-recovery-reply' → user typed something
            // else; fall through to normal handling so we don't swallow
            // unrelated messages.
          }
        } catch (err) {
          ctx.logger.warn({
            event: 'recovery.intercept_crashed',
            err: err instanceof Error ? err.message : String(err),
          }, 'recovery intercept threw — falling through to normal flow')
        }

        // v1.2.89 — ask_user text-reply intercept. handleAskOp registers
        // a pending entry keyed by (platform, channelId, threadId); when
        // the user replies with one of the choice tokens (1 / a / 通过 / …),
        // we resolve the pending Promise the calling agent is awaiting.
        // BEFORE this commit, tryHandleAskReply was defined but never
        // called from anywhere — so an agent's mcp__agim__ask_user call
        // would surface the choice card but the user's typed reply went
        // straight to the agent as a fresh prompt, leaving the ask
        // dangling until the configured timeout. Runs BEFORE the approval
        // intercept since asks are blocking the calling agent's progress
        // — if both exist on the same thread (rare) the ask wins.
        try {
          const { tryHandleAskReply } = await import('./core/ask-user-router.js')
          if (tryHandleAskReply(ctx.platform, ctx.channelId, ctx.message.threadId, ctx.message.text)) {
            ctx.logger.info({ event: 'message.consumed_by_ask_user' })
            return
          }
        } catch (err) {
          ctx.logger.warn({
            event: 'ask.intercept_crashed',
            err: err instanceof Error ? err.message : String(err),
          }, 'ask-user intercept threw — falling through to normal flow')
        }

        // Approval interception comes BEFORE the agent router. If a pending
        // approval exists for this thread and the message is a y/n-style
        // reply, we resolve the approval and stop. Anything else routes
        // normally (with the side effect of auto-denying any stale pending —
        // see approval-router.ts).
        if (tryHandleApprovalReply(threadKey(ctx.platform, ctx.channelId, ctx.message.threadId), ctx.message.text)) {
          ctx.logger.info({ event: 'message.consumed_by_approval' })
          return
        }

        // Reminder-intent confirmation reply ("y"/"n" to a previously-
        // proposed reminder card). Must come BEFORE the detector so a
        // user replying "y" doesn't get re-detected as another reminder.
        const tk = `${ctx.platform}:${ctx.channelId}:${ctx.message.threadId}`

        // Location-context injection: if the user shared a native pin /
        // venue on Telegram or Feishu within the last 5 min, the adapter
        // stashed the WGS-84 coords in core/location-context. Prepend a
        // structured annotation to the user's text so the agent can decide
        // what to do (save_memo with these coords, ignore, ask follow-up).
        // Single-shot: consuming clears the stash so the next turn doesn't
        // accidentally re-inject. Matches the WeChat H5-flow architecture:
        // the agent is the decision-maker; adapters just surface data.
        const locCtxStash = consumeLocationContext(tk)
        if (locCtxStash) {
          const annotation = formatLocationAnnotation(locCtxStash)
          ctx.message.text = `${annotation}\n\n${ctx.message.text}`
          ctx.logger.info({
            event: 'message.location_context_injected',
            lat: locCtxStash.lat,
            lng: locCtxStash.lng,
            hasVenue: !!locCtxStash.venueLabel,
          })
        }

        const replyDecision = tryConsumePendingReminderReply(tk, ctx.message.text)
        if (replyDecision) {
          if (replyDecision.decision === 'cancel') {
            await sink.deliver({
              platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
              payload: '✅ 已忽略这条提醒建议', kind: 'text',
            })
          } else {
            const p = replyDecision.pending
            try {
              const id = createReminder({
                fireAt: p.fireAt,
                text: p.text,
                platform: ctx.platform,
                channelId: ctx.channelId,
                threadId: ctx.message.threadId,
                userId: ctx.message.userId || '',
                source: 'slash',
                recurrence: p.recurrence,
              })
              const recurLine = p.recurrence ? `\n   循环：${p.recurrence}` : ''
              await sink.deliver({
                platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
                payload: `✅ 已创建提醒 #${id}\n   触发：${p.fireAt.toLocaleString()}${recurLine}\n   内容：${p.text}`,
                kind: 'text',
              })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              await sink.deliver({
                platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
                payload: `❌ 创建失败：${msg}`, kind: 'text',
              })
            }
          }
          ctx.logger.info({ event: 'message.consumed_by_pending_reminder', decision: replyDecision.decision })
          return
        }

        // Service-control intent detection — catches "重启服务" / "restart
        // bot" / "状态" etc. BEFORE they reach the LLM, which would
        // otherwise be tempted to run `kill <pid>` or `systemctl restart`
        // and bypass the entire pre-flight + completion-push pipeline.
        // Only on non-slash messages (slash commands have their own
        // parser); slash forms go through routeMessage normally.
        if (!ctx.message.text.trim().startsWith('/')) {
          const { detectServiceIntent } = await import('./core/service-intent.js')
          const svcIntent = detectServiceIntent(ctx.message.text)
          if (svcIntent) {
            ctx.logger.info({
              event: 'service-intent.matched',
              intent: svcIntent.intent,
              confidence: svcIntent.confidence,
              userId: ctx.message.userId,
            })
            const routeCtx: RouteContext = {
              channelId: ctx.channelId,
              threadId: ctx.message.threadId,
              platform: ctx.platform,
              defaultAgent: getDefaultAgent(config.defaultAgent),
              traceId,
              logger: ctx.logger,
              userId: ctx.message.userId,
            }
            const { handleRestartCommand, handleStopCommand, handleStatusCommand } =
              await import('./core/commands/service.js')
            let reply: string
            if (svcIntent.intent === 'restart') reply = await handleRestartCommand('', routeCtx)
            else if (svcIntent.intent === 'stop') reply = await handleStopCommand('', routeCtx)
            else reply = await handleStatusCommand('', routeCtx)
            // v1.1.10: /restart now delivers its "重启中…" ack synchronously
            // from inside initiateRestart() to win the race against the new
            // process's "✅ 已重启完成…" push. In that case the handler
            // returns an empty string — skip the duplicate sink call.
            if (reply && reply.length > 0) {
              await sink.deliver({
                platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
                payload: reply, kind: 'text',
              })
            }
            return
          }
        }

        // Reminder-intent detector: only on non-slash messages and only
        // when the user has aiwatch on. Cheap regex pre-filter inside the
        // detector skips most messages without a time hint, so the LLM
        // call only fires on plausible candidates.
        if (!ctx.message.text.trim().startsWith('/')) {
          try {
            const detected = await tryDetectReminderIntent({
              platform: ctx.platform,
              channelId: ctx.channelId,
              threadId: ctx.message.threadId,
              userId: ctx.message.userId || '',
              text: ctx.message.text,
            })
            if (detected.handled && detected.reply) {
              await sink.deliver({
                platform: ctx.platform, channelId: ctx.channelId, threadId: ctx.message.threadId,
                payload: detected.reply, kind: 'text',
              })
              ctx.logger.info({ event: 'message.proposed_reminder' })
              return
            }
          } catch (err) {
            // Detector must never break the message pipeline. Log and
            // fall through to normal agent dispatch.
            ctx.logger.warn({
              event: 'remind-intent.crashed',
              err: err instanceof Error ? err.message : String(err),
            }, 'detector crashed — falling through to normal agent flow')
          }
        }

        await handleMessage(ctx, config.defaultAgent)
      })

      try {
        await messenger.start()
        console.log(`✅ Started messenger: ${name}`)
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        console.error(`❌ Failed to start messenger ${name}:`)
        console.error(`   ${errMsg}`)
        // Show actionable next step, not stack trace
        const hint = formatMessengerStartError(name, error)
        if (hint !== errMsg) {
          console.error(`   ${hint}`)
        }
      }
    }

    // ============================================
    // WIRE APPROVAL ROUTER (after messengers are up)
    // ============================================

    if (approvalBus.getSocketPath()) {
      installApprovalRouter({
        resolveMessenger: (platform: string) => registry.getMessenger(platformToMessengerName(platform)),
      })
      console.log('✅ Approval router wired to messengers')
    }

    // Start the outbox worker AFTER all messengers have been registered/
    // started. If we started it earlier, every queued row from a prior run
    // would fail "messenger not registered" on the first tick and bounce
    // into backoff — minor but pointless. Worker is single-threaded and
    // ticks at AGIM_OUTBOX_TICK_MS (default 1s).
    sink.startWorker()
    console.log('✅ Message-sink worker started')

    // Phase 3 — startup recovery scan. Look at jobs.db for inline rows
    // that got 'interrupted' on the previous shutdown and are still inside
    // the recovery window (default 10 min, env AGIM_RECOVERY_WINDOW_MS).
    // For each, send a "回 1 重发 / 2 取消" prompt via sink — outbox will
    // hold the notification until the messenger is fully connected. Older
    // interrupted rows transition to 'abandoned' so we don't ask the user
    // to retry something they sent half an hour ago.
    try {
      const { scanInterruptedAndNotify, sweepExpiredPending } =
        await import('./core/job-recovery.js')
      const { notified, abandoned } = await scanInterruptedAndNotify()
      if (notified > 0 || abandoned > 0) {
        console.log(`✅ Job recovery: ${notified} retry-prompt(s) sent, ${abandoned} abandoned`)
      }
      // Tidy expired pending entries every minute. The in-memory map is
      // cheap but a long-lived process accumulates entries from users who
      // never reply.
      const sweepTimer = setInterval(() => { sweepExpiredPending() }, 60_000)
      if (typeof sweepTimer === 'object' && sweepTimer && 'unref' in sweepTimer) {
        (sweepTimer as { unref: () => void }).unref()
      }
    } catch (err) {
      console.warn('job-recovery module failed to scan:', err instanceof Error ? err.message : String(err))
    }

    // Reminder confirm notifier — used by reminder-rpc.ts when an agent
    // creates a high-frequency + LLM-polish reminder (those go through a
    // y/n card before landing in the DB). Plain message via the same
    // messenger the agent is talking on.
    setReminderConfirmNotifier(async (ctx, message) => {
      // sink resolves the adapter at delivery time; we just need to canonicalize
      // the messenger name (e.g. 'wechat' → 'wechat-ilink') so the worker picks
      // the right adapter from the registry.
      const canonical = platformToMessengerName(ctx.platform)
      const platform = registry.getMessenger(canonical) ? canonical : ctx.platform
      await sink.deliver({
        platform,
        channelId: ctx.channelId,
        threadId: ctx.threadId,
        payload: message,
        kind: 'text',
      })
    })

    // ============================================
    // START WEB CHAT SERVER
    // ============================================

    let webServer: { close: () => void; port: number } | undefined
    try {
      webServer = await startWebServer({
        port: config.webPort as number | undefined,
        defaultAgent: config.defaultAgent,
      })
      try {
        const { setBootPhase } = await import('./core/boot-state.js')
        setBootPhase('web_ready')
      } catch { /* ignore */ }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.warn(`⚠️ Web chat server failed to start: ${errMsg}`)
    }

    // v1.5 — long-term memory consolidator. Runs periodically (default
    // every 24h) to refresh persona_profile from accumulated facts using
    // the user's most recently active agent. No-op when
    // AGIM_MEMORY_ENABLED != 1.
    try {
      const { startMemoryConsolidator } = await import('./core/memory-consolidate.js')
      startMemoryConsolidator()
    } catch (err) {
      console.warn('Memory consolidator failed to start:', err instanceof Error ? err.message : String(err))
    }

    // P1 — dream distillation. Background pass that batch-extracts the turns
    // buffered on the hot path when the system is idle (or past the staleness
    // floor). No-op when AGIM_MEMORY_ENABLED != 1.
    try {
      const { startMemoryDistiller } = await import('./core/memory-distiller.js')
      startMemoryDistiller()
    } catch (err) {
      console.warn('Memory distiller failed to start:', err instanceof Error ? err.message : String(err))
    }

    // v1.1.8 — Viewer auto-tunnel. If the operator opted into the
    // cloudflared quick-tunnel mode AND there's no static public URL set,
    // fork cloudflared so /v/:id links the agent puts in IM are reachable
    // from a phone without any reverse-proxy setup. URL is ephemeral —
    // see src/core/tunnel.ts for the trade-off discussion.
    try {
      const { getViewerConfig } = await import('./core/viewer-config.js')
      const { startTunnel, findCloudflared } = await import('./core/tunnel.js')
      const vcfg = getViewerConfig()
      if (vcfg.enabled && vcfg.tunnelMode === 'quick' && !vcfg.publicBaseUrl && webServer) {
        if (findCloudflared()) {
          startTunnel(webServer.port)
        } else {
          console.warn('⚠️ Viewer quick-tunnel mode is on, but cloudflared is not installed. Install via your package manager or download from https://github.com/cloudflare/cloudflared/releases — viewer links will fall back to inline truncation until then.')
        }
      }
    } catch (err) {
      console.warn('Viewer tunnel start failed:', err instanceof Error ? err.message : String(err))
    }

    // ============================================
    // START ACP SERVER
    // ============================================

    let acpServer: { close: () => void; port: number } | undefined
    const acpPort = (config as Record<string, unknown>).acpPort as number | undefined || undefined
    try {
      acpServer = await startACPServer({
        port: acpPort,
        defaultAgent: config.defaultAgent,
      })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.warn(`⚠️ ACP server failed to start: ${errMsg}`)
    }

    console.log('\n✅ IM hub is running!')
    if (webServer) {
      console.log(`   Chat UI: http://localhost:${webServer.port}`)
    }
    if (acpServer) {
      console.log(`   ACP Endpoint: http://localhost:${acpServer.port}`)
    }
    console.log('Press Ctrl+C to stop')

    // v1.5 — flip boot phase to 'ready' so the web restart-polling UI
    // can wait for full readiness instead of merely "HTTP server up".
    try {
      const { setBootPhase, getBootInfo } = await import('./core/boot-state.js')
      setBootPhase('ready')
      const info = getBootInfo()
      console.log(`   Boot ready in ${(info.msSinceStart / 1000).toFixed(1)}s`)
    } catch { /* ignore */ }

    // v1.2.2 — eager-warm the vector backend so post-restart status is
    // accurate without waiting for the first inbound message / Memory tab
    // visit. The constructor's autowarm only fires when getActiveBackend()
    // is first called, so we trigger it here. Fire-and-forget; failures
    // are logged inside the backend.
    try {
      const { isMemoryEnabled } = await import('./core/persona.js')
      if (isMemoryEnabled()) {
        const { getActiveBackend } = await import('./core/memory-vector.js')
        getActiveBackend()  // constructor → autowarm
      }
    } catch { /* ignore */ }

    // If we came back from a `/restart`, the previous instance dropped a
    // ~/.agim/restart-pending.json with the initiator's IM thread. Now
    // that messengers + agents are all up, push the completion message
    // (or warning) back to that thread and delete the file. Fire and
    // forget — never block startup on this.
    try {
      const { processRestartPending } = await import('./core/restart-completion.js')
      void processRestartPending(config.defaultAgent).catch((err) => {
        console.warn('restart-completion handler threw:', err instanceof Error ? err.message : String(err))
      })
    } catch (err) {
      console.warn('restart-completion module failed to load:', err instanceof Error ? err.message : String(err))
    }

    // Graceful shutdown. Registered for BOTH SIGINT (Ctrl-C from a terminal)
    // and SIGTERM (systemd / docker stop). Prior to v1.1.2 only SIGINT was
    // hooked, which meant `systemctl restart agim` skipped this entire path —
    // sessionManager.stop, WAL checkpoints, etc. — and the next startup had
    // to recover from a half-flushed state. The handler is idempotent against
    // duplicate signals.
    let shuttingDown = false
    let shutdownExitCode = 0
    // R14 — hard deadline. If anything in the teardown chain hangs (DB
    // checkpoint, stuck child wait, sidecar TCP keepalive), we still
    // force-exit within 25s so a follow-up `systemctl restart` finds
    // the port released. systemd's TimeoutStopSec is 30s; we leave a
    // 5s buffer so the process exits on our terms (exit code 1)
    // before systemd escalates to SIGKILL.
    const HARD_SHUTDOWN_MS = 25_000
    const gracefulShutdown = async (signal: string, exitCode = 0): Promise<void> => {
      shutdownExitCode = Math.max(shutdownExitCode, exitCode)
      if (shuttingDown) return
      shuttingDown = true
      console.log(`\n👋 Received ${signal}, shutting down...`)

      const hardKill = setTimeout(() => {
        console.error(`⏱  Graceful shutdown exceeded ${HARD_SHUTDOWN_MS}ms — forcing exit(1).`)
        // Last-ditch: try to release the port before the kernel does
        // it on exit. close() is safe to call from a fired timer
        // because shuttingDown is true so nothing re-enters this fn.
        try { webServer?.close() } catch { /* ignore */ }
        try { acpServer?.close() } catch { /* ignore */ }
        // PID_FILE cleanup intentionally NOT done here — the next
        // start's self-check uses pidAlive(recorded), which returns
        // false for our soon-to-be-dead pid, so stale file is harmless.
        process.exit(1)
      }, HARD_SHUTDOWN_MS)
      // Don't keep the event loop alive solely for this timer; if
      // shutdown completes naturally, clearTimeout below + the natural
      // process.exit(0) wins.
      if (typeof hardKill.unref === 'function') hardKill.unref()

      // PORT RELEASE FIRST — close webServer + acpServer at the top of
      // the chain (was previously after sessionManager.stop, which is
      // cheap but unnecessary friction). closeAllConnections() (added
      // inside startWebServer/startACPServer in R14) force-drops
      // in-flight sockets so the listener actually releases the port
      // before any DB / messenger teardown begins.
      sessionManager.stop()
      try { webServer?.close() } catch { /* ignore */ }
      try { acpServer?.close() } catch { /* ignore */ }

      // Stop the cloudflared subprocess (if we forked one for viewer auto-tunnel).
      // Doing this early gives it a clean SIGTERM exit before we tear down the
      // rest; otherwise it would exit on parent-process close with no cleanup.
      try {
        const { stopTunnel } = await import('./core/tunnel.js')
        stopTunnel()
      } catch { /* ignore */ }

      // v1.5 — stop the memory consolidator timer.
      try {
        const { stopMemoryConsolidator } = await import('./core/memory-consolidate.js')
        stopMemoryConsolidator()
      } catch { /* ignore */ }

      // Stop the outbox worker BEFORE messengers so no new send attempts
      // race the adapter shutdown. Worker is single-threaded so a pending
      // tick will finish its current row before we move on.
      try { sink.stopWorker() } catch { /* ignore */ }

      // Phase 3: any inline job that was still pending/running gets stamped
      // 'interrupted' so the next startup's recovery scan can offer the user
      // a retry. Must happen BEFORE closeJobBoardDb() below, while the
      // handle is still open.
      try {
        const { markRunningInlineJobsInterrupted } = await import('./core/job-board.js')
        markRunningInlineJobsInterrupted(`agim shutdown (${signal})`)
      } catch { /* ignore */ }

      // Stop all messengers
      for (const name of registry.listMessengers()) {
        const messenger = registry.getMessenger(name)
        if (messenger) {
          await messenger.stop()
        }
      }

      // Stop approval bus last — denies any in-flight approvals so sidecar
      // processes don't hang. Always called even if start() failed earlier.
      try { await approvalBus.stop() } catch { /* ignore */ }

      // L2: stop background sweepers and checkpoint SQLite WAL files before
      // exiting. Without these, the next startup has to recover the WAL
      // (cheap but visible in logs and slows boot).
      try {
        const { stopRetentionSweep, closeAuditDb } = await import('./core/audit-log.js')
        stopRetentionSweep()
        closeAuditDb()
      } catch { /* ignore */ }
      try {
        const { stopJobRetentionSweep, closeJobBoardDb } = await import('./core/job-board.js')
        stopJobRetentionSweep()
        closeJobBoardDb()
      } catch { /* ignore */ }
      try {
        const { stopScheduler, closeScheduleDb } = await import('./core/schedule.js')
        stopScheduler()
        closeScheduleDb()
      } catch { /* ignore */ }
      try {
        const { stopReminderEngine, closeReminderDb } = await import('./core/reminders.js')
        stopReminderEngine()
        closeReminderDb()
      } catch { /* ignore */ }
      try {
        const { closeMemosDb } = await import('./core/memos.js')
        closeMemosDb()  // also stops the sweep timer
      } catch { /* ignore */ }
      try {
        const { stopOutboxRetentionSweep, closeOutboxDb } = await import('./core/outbox.js')
        stopOutboxRetentionSweep()
        closeOutboxDb()
      } catch { /* ignore */ }

      // R14 — kill the opencode-serve daemon (singleton subprocess).
      // Before R14 this was never stopped explicitly; it relied on
      // parent-exit propagation, which leaves the child as a zombie
      // when agim is killed by SIGKILL or when the cgroup is broken
      // (the exact failure mode that motivated R14). Inline import
      // keeps the lazy graph clean for non-opencode deployments.
      try {
        const { opencodeServe } = await import('./plugins/agents/opencode/serve-manager.js')
        await opencodeServe.stop()
      } catch { /* ignore — opencode wasn't configured / never spawned */ }

      // R15 — pair the start-path PID_FILE write. We only unlink when
      // the file's pid matches OUR pid; defensive against a race where
      // a fresh agim has already overwritten it (we don't want to
      // delete the new owner's file just because our shutdown started
      // first).
      try {
        const { PID_FILE: _pidFile } = await import('./cli-ui/service.js')
        const { existsSync: _exists, readFileSync: _read, unlinkSync: _unlink } = await import('node:fs')
        if (_exists(_pidFile)) {
          const recorded = parseInt(_read(_pidFile, 'utf-8').trim(), 10)
          if (recorded === process.pid) _unlink(_pidFile)
        }
      } catch { /* missing / unreadable is fine */ }

      clearTimeout(hardKill)
      process.exit(shutdownExitCode)
    }
    requestFatalShutdown = () => { void gracefulShutdown('uncaughtException', 1) }
    process.on('SIGINT', () => { void gracefulShutdown('SIGINT') })
    process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM') })

    // Wait forever
    await new Promise(() => {})
  })

/**
 * Handle incoming message from any messenger
 */
async function handleMessage(ctx: MessageContext, defaultAgent: string): Promise<void> {
  const { message, platform } = ctx
  const traceId = ctx.traceId || generateTraceId()
  const logger = ctx.logger || createLogger({ traceId, platform, component: 'cli' })

  const messengerName = platform === 'wechat' ? 'wechat-ilink' : platform
  const messenger = registry.getMessenger(messengerName)

  if (!messenger) {
    console.error(`No messenger found for platform: ${platform}`)
    return
  }

  // Agent-name prefix removed — historically we prepended "[opencode]\n\n"
  // / "[codex]\n\n" / etc. so users could see which agent answered when
  // they were on a non-default sticky session. In practice it cluttered
  // every reply (most users only ever stick with one agent per channel)
  // and made memo/reminder confirmations look noisy. If the user wants to
  // know the active agent they can run `/status` or `/router status`.
  const maybePrefix = async (text: string): Promise<string> => text

  const stopTyping = async () => {
    if (messenger.sendTyping) {
      try {
        await messenger.sendTyping(message.threadId, false)
      } catch {
        // Ignore typing errors
      }
    }
  }

  // Build route context with trace.
  // v1.2.103 — read defaultAgent through getDefaultAgent() so the SPA's
  // "default agent" picker takes effect on the very next message instead
  // of waiting for a service restart. The `defaultAgent` parameter is
  // kept as the fallback (tests inject a fixed value; live-config
  // unset → param wins).
  const routeCtx: RouteContext = {
    threadId: message.threadId,
    channelId: ctx.channelId,
    platform,
    defaultAgent: getDefaultAgent(defaultAgent),
    traceId,
    logger,
    userId: message.userId,
  }

  // Thinking placeholder — sent if the adapter supports it, dismissed (when
  // the adapter knows how) just before the real response goes out. Skip for
  // y/n-style approval replies which already get a same-thread effect from
  // the resolved approval card; sending "🤔 思考中…" there would just add
  // noise. We approximate that filter by skipping placeholders for messages
  // that look like single-token approval words.
  let dismissThinking: (() => Promise<void>) | undefined
  const looksLikeApproval = /^\s*[yn]\s*$/i.test(message.text) ||
    /^\s*(批准|拒绝|同意|不同意|通过|可以|不可以|不行|✅|❌)\s*$/.test(message.text)

  // Inline-job tracking id (Phase 2). Declared at function scope so the
  // catch block below can mark the row 'failed' on any throw. -1 means
  // "not tracked": either the message didn't reach willInvokeAgent, or
  // createInlineJob fell back to in-memory (DB locked / AGIM_INLINE_JOB_TRACKING=0).
  let inlineJobId = -1

  try {
    if (messenger.sendTyping) {
      messenger.sendTyping(message.threadId, true).catch(() => {})
    }

    const parsed = parseMessage(message.text)
    logger.debug({ event: 'router.parse', parsed: parsed.type })

    // Only show "🤔 思考中…" for messages that will actually go through the
    // agent — built-in/system commands (/help /status /audit /router etc.)
    // respond instantly so a placeholder would race the real reply.
    const willInvokeAgent =
      (parsed.type === 'default' || parsed.type === 'agent' || parsed.type === 'agentCommand') &&
      !looksLikeApproval

    // Prepare native agent sessions lazily — the router calls
    // onAgentResolved once intent classification picks the final agent,
    // so we never allocate a Claude UUID for an opencode run (or vice versa).
    //
    // Important: claude-code writes its session jsonl as soon as the run
    // starts, so markClaudeSessionPrimed MUST happen before the adapter is
    // invoked. If the run later errors, the next turn must use --resume or
    // claude refuses with "session already exists". We therefore mark
    // primed inside onAgentResolved (right after we wire agentSessionId)
    // rather than after routeMessage returns.
    if (willInvokeAgent) {
      routeCtx.onAgentResolved = async (resolvedAgent: string) => {
        const prepared = await sessionManager.prepareAgentSession(
          platform, ctx.channelId, message.threadId, resolvedAgent,
        )
        routeCtx.agentSessionId = prepared.agentSessionId
        routeCtx.agentSessionResume = prepared.agentSessionResume
      }
    }

    // Inline-job tracking: every agent-bound inbound message gets a row in
    // the jobs table (kind='inline') so the state machine survives crashes
    // and the Phase 3 startup scan can offer the user a retry. Built-ins
    // (status/audit/router) return string immediately and never touch the
    // agent — no point tracking them. Inline tracking can be killed wholesale
    // via env AGIM_INLINE_JOB_TRACKING=0 (createInlineJob returns -1, every
    // mark*Job helper no-ops on id<=0). createInlineJob itself never throws —
    // if the DB is locked or disk-full we get -1 and the user path runs
    // unchanged on the in-memory fast path.
    //
    // We create the row BEFORE entering the runOnThread queue so a stuck
    // queue (or runAgentInvocation crash before the agent runs) still leaves
    // a 'pending' record we can attribute to the user. The agent name is
    // initially defaultAgent and gets corrected from inside onAgentResolved
    // once routing picks the real one.
    //
    // EXCEPTION: when the cli's recovery interceptor handed us a pre-created
    // replacement-job id via ctx.inlineJobId, reuse it. The recovery path
    // had to create the row up-front so it could stamp replaced_by on the
    // old interrupted row atomically; building a second row here would
    // leave the recovery-created one as an orphan 'pending' that retention
    // eventually GCs.
    if (willInvokeAgent) {
      if (ctx.inlineJobId && ctx.inlineJobId > 0) {
        inlineJobId = ctx.inlineJobId
      } else {
        inlineJobId = createInlineJob({
          agent: defaultAgent,
          prompt: message.text,
          threadKey: `${platform}:${ctx.channelId}:${message.threadId}`,
          creatorId: message.userId ?? '',
        })
      }
      // A2A-L1: stash on routeCtx so callAgentWithHistory can forward it
      // through AgentSendOpts → adapter.registerRun → RunContext. When the
      // agent fires mcp__agim__call_agent the bus then knows what
      // parent_id to stamp on the callee inline-job row. User-originated
      // runs are call_depth=0; nested runs (A2A callees) reach this same
      // handler with their own ctx.inlineJobId and ctx.callDepth set.
      if (inlineJobId > 0) {
        routeCtx.parentJobId = inlineJobId
        // handleMessage is only the user-inbound path — callDepth is
        // always 0 here. (A2A callees don't traverse this handler; they
        // go through a2a.callAgentByName which passes its own callDepth
        // directly to target.sendPrompt.)
        routeCtx.callDepth = 0
      }
    }

    // Chain the agent-name correction onto the existing onAgentResolved
    // (which already wires native session ids). Both run sequentially —
    // the inline-job update is fast and best-effort.
    const prevOnResolved = routeCtx.onAgentResolved
    if (prevOnResolved || inlineJobId > 0) {
      routeCtx.onAgentResolved = async (resolvedAgent: string) => {
        if (prevOnResolved) await prevOnResolved(resolvedAgent)
        updateJobAgent(inlineJobId, resolvedAgent)
      }
    }

    // The thinking placeholder + agent invocation + response delivery are
    // wrapped into a closure so agent-bound messages can be serialized
    // per-thread via runOnThread (see core/thread-queue.ts). Without
    // serialization, two messages arriving in quick succession on the same
    // threadId race each other into the agent — claude-code blows up on
    // duplicate --session-id, codex / opencode get interleaved I/O, and
    // the user sees mangled responses. Built-ins and approval replies
    // (willInvokeAgent === false) bypass the queue so a `y` reply can
    // still resolve an approval card while an agent run is in flight.
    const runAgentInvocation = async (): Promise<void> => {
      if (willInvokeAgent && messenger.sendThinking) {
        try {
          dismissThinking = await messenger.sendThinking(
            message.threadId,
            '🤔 思考中…',
          )
        } catch (err) {
          logger.debug({ err: String(err) }, 'sendThinking failed')
        }
      }

      // Mark inline job 'running' just before the agent actually starts —
      // anything that throws before this leaves the row in 'pending' which
      // is the correct "never ran" semantic.
      markJobRunning(inlineJobId)

      const result = await routeMessage(parsed, routeCtx)

      const dismiss = async () => {
        if (dismissThinking) {
          try { await dismissThinking() } catch { /* ignore */ }
          dismissThinking = undefined
        }
      }

      // Handle response (string or async generator)
      if (typeof result === 'string') {
        await stopTyping()
        await dismiss()
        markJobCompleted(inlineJobId, result)
        // v1.2.73 — `result: string` is no longer exclusively "slash
        // command output". Cases that fall into this branch:
        //   1. slash command (e.g. /job list, /a2a tree, /restart, /audit)
        //      → willInvokeAgent === false → source 'system' (inline)
        //   2. agent error short-circuit (handleAgentCommand returns
        //      "❌ Agent X not available", "❌ Task #N gone" before ever
        //      reaching the adapter) → willInvokeAgent === true →
        //      source 'agent' (so viewer routing can still kick in if
        //      the error happens to be long; usually short → inline)
        //   3. an adapter that returns its FULL reply as a single string
        //      (observed with Codex when it surfaces a markdown-table
        //      response through the agent-call path) → willInvokeAgent
        //      === true → source 'agent' → message-sink can viewer-route
        //      long content. Before this fix the body got force-inlined
        //      as 'system', so markdown tables came through verbatim
        //      and rendered poorly in IM.
        //
        // Empty-string return signals "I already delivered the reply
        // myself" — used by /restart which pushes its in-flight ack via
        // sink with priority='high' to win the race against the new
        // process's completion push. Skip the duplicate sink call.
        if (result.length > 0) {
          const sinkRes = await sink.deliver({
            platform, channelId: ctx.channelId, threadId: message.threadId,
            payload: await maybePrefix(result), kind: 'text',
            jobId: inlineJobId > 0 ? inlineJobId : undefined,
            source: willInvokeAgent ? 'agent' : 'system',
          })
          if (sinkRes.outboxId > 0) linkJobOutbox(inlineJobId, sinkRes.outboxId)
        }
        logger.info({ event: 'message.sent', responseLen: result.length })
      } else {
        // Stream response chunks
        let fullResponse = ''
        for await (const chunk of result) {
          fullResponse += chunk
        }

        await stopTyping()
        await dismiss()

        if (fullResponse) {
          markJobCompleted(inlineJobId, fullResponse)
          const sinkRes = await sink.deliver({
            platform, channelId: ctx.channelId, threadId: message.threadId,
            payload: await maybePrefix(fullResponse), kind: 'text',
            jobId: inlineJobId > 0 ? inlineJobId : undefined,
            source: 'agent', // freeform LLM output → eligible for viewer routing
          })
          if (sinkRes.outboxId > 0) linkJobOutbox(inlineJobId, sinkRes.outboxId)
          logger.info({ event: 'message.sent', responseLen: fullResponse.length })
        } else {
          // Empty response is treated as a failure of the inline job —
          // there's nothing to deliver and we don't want the row stuck in
          // 'running' forever. The user already sees nothing; the row gets
          // pruned out of /jobs lists.
          markJobFailed(inlineJobId, 'agent returned empty response')
          logger.warn({ event: 'message.empty_response' })
        }
      }
    }

    if (willInvokeAgent) {
      const queueKey = `${platform}:${ctx.channelId || 'default'}:${message.threadId}`
      await runOnThread(queueKey, runAgentInvocation, {
        onQueued: async (ahead) => {
          logger.info({ event: 'message.queued', ahead, queueKey })
          await sink.deliver({
            platform, channelId: ctx.channelId, threadId: message.threadId,
            payload: `📥 已收到（前面还有 ${ahead} 条在处理，稍后给你结果）`,
            kind: 'text',
          })
        },
      })
    } else {
      await runAgentInvocation()
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error({ event: 'message.error', error: errMsg })
    await stopTyping()
    if (dismissThinking) {
      try { await dismissThinking() } catch { /* ignore */ }
    }
    // Mark inline job 'failed' before sending the user error — markJobFailed
    // is a no-op for id<=0 (built-ins / inline tracking disabled) and for
    // already-terminal rows. The error blurb still goes through sink so it
    // survives an IM hiccup.
    markJobFailed(inlineJobId, errMsg)
    await sink.deliver({
      platform, channelId: ctx.channelId, threadId: message.threadId,
      payload: '❌ An error occurred processing your message.', kind: 'text',
    }).catch(() => { /* swallow — sink already logs */ })
  }
}

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
    const config = await loadConfig()
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
      // duplicating the 500-line start body.
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
