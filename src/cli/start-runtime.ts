import { join } from 'node:path'
import { registry } from '../core/registry.js'
import { sessionManager } from '../core/session.js'
import type { MessageContext } from '../core/types.js'
import { generateTraceId, createLogger, logger as rootLogger } from '../core/logger.js'
import { validateConfig } from '../core/config-schema.js'
import { workspaceRegistry } from '../core/workspace.js'
import { bootstrapAgentWorkspaces } from '../core/agent-cwd.js'
import { ensureBgjobInstalled } from '../core/bgjob-install.js'
import { approvalBus } from '../core/approval-bus.js'
import { install as installApprovalRouter, platformToMessengerName } from '../core/approval-router.js'
import { setReminderConfirmNotifier } from '../core/reminder-rpc.js'
import { sink } from '../core/message-sink.js'
import {
  checkMessengerConfig,
  checkAgentAvailability,
  runMessengerOnboarding,
  formatMessengerStartError,
  loadConfig as loadOnboardingConfig,
  saveConfigChanges as saveOnboardingConfigChanges,
  type Config,
} from '../core/onboarding.js'
import { startWebServer } from '../web/server.js'
import { AGIM_HOME } from '../core/agim-paths.js'
import { handleMessage } from './handle-message.js'
import { handleInboundMessage } from './messenger-inbound.js'
import { gracefulShutdown } from './graceful-shutdown.js'
import type { StartRuntimeContext } from './start-context.js'

const CONFIG_FILE = join(AGIM_HOME, 'config.json')

async function loadConfig(): Promise<Config> {
  return loadOnboardingConfig()
}

async function saveConfigChanges(base: Config, next: Config): Promise<Config> {
  return saveOnboardingConfigChanges(base, next)
}

export async function runStartForeground(): Promise<void> {
  console.log('🚀 Starting Agim (阿吉姆)…')

  // Upgrade hygiene: drop retired ACP keys (acpPort / acpAgents / AGIM_ACP_BIND)
  // left behind by older installs so port conflict hints never mention :9090.
  try {
    const { purgeRetiredAcpResidue } = await import('../cli-ui/retire-acp-residue.js')
    const purged = await purgeRetiredAcpResidue()
    if (purged.configKeysRemoved.length || purged.envKeysRemoved.length) {
      const bits = [
        ...purged.configKeysRemoved.map((k) => `config.${k}`),
        ...purged.envKeysRemoved,
      ]
      console.log(`   Cleaned retired ACP settings: ${bits.join(', ')}`)
    }
  } catch { /* best-effort */ }

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
    const { PID_FILE } = await import('../cli-ui/service.js')
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
          const { AGIM_HOME: _home } = await import('../core/agim-paths.js')
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
    const { PID_FILE: _pidFile } = await import('../cli-ui/service.js')
    const { writeFileSync: _writePid, chmodSync: _chmodPid } = await import('node:fs')
    _writePid(_pidFile, `${process.pid}\n`, { mode: 0o600 })
    try { _chmodPid(_pidFile, 0o600) } catch { /* non-POSIX */ }
  } catch (err) {
    // Failing to write the pidfile is non-fatal — self-check next
    // time will fall back to no-file. Log and continue.
    console.warn(`⚠️  Could not write PID file: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Same R15 idea for ~/.agim/agim.log: historically only --bg / restart
  // helper redirected stdio into the file. systemd + foreground never
  // created it, so Web Settings log-tail stayed empty. Mirror console
  // (and pino) into the file unless AGIM_LOG_REDIRECTED=1 (bg child).
  try {
    const { ensureServiceLogMirror } = await import('../cli-ui/service.js')
    ensureServiceLogMirror()
  } catch (err) {
    console.warn(`⚠️  Could not open service log: ${err instanceof Error ? err.message : String(err)}`)
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

  // Naming v2: Agim Agent id, tenants field, session dirs (see
  // docs/migration-naming-v2.md). Idempotent flags on config.json.
  {
    const {
      migrateNamingV2,
      migratePiSessionsDir,
      migrateSessionAgentIds,
      migrateAgentWorkspaceDir,
    } = await import('../core/naming-migrate.js')
    const { saveConfig: persistConfig } = await import('../core/onboarding.js')
    const migrated = migrateNamingV2(config)
    if (migrated.changed) {
      config = migrated.config
      try {
        await persistConfig(config)
        console.log('Config migration: naming v2 (agim agent id / tenants)')
      } catch (err) {
        console.warn(
          `⚠️  Could not persist naming v2 migration: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    try {
      migratePiSessionsDir()
      migrateAgentWorkspaceDir()
      const n = migrateSessionAgentIds()
      if (n > 0) console.log(`Session migration: rewrote agent id on ${n} session file(s)`)
    } catch (err) {
      console.warn(
        `⚠️  Filesystem naming migration issue: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
    // Prefer tenants[] for workspace registry (workspaces[] is read-alias).
  }

  // v1.2.103 — publish the in-memory config to the live-config singleton
  // so registry filters + routeCtx + Web defaultAgent all see the same
  // values. PUT /api/config will republish on save, removing the need for
  // a service restart after toggling enabled agents / default agent in
  // the SPA.
  const { setLiveConfig } = await import('../core/live-config.js')
  setLiveConfig(config)

  // Initialize workspace registry (config.tenants preferred; workspaces alias)
  const { getTenantsFromConfig } = await import('../core/naming-migrate.js')
  const tenants = getTenantsFromConfig(config as Record<string, unknown>) as Array<{
    id: string; name: string; agents: string[]
    members?: string[]
    rateLimit?: { rate: number; intervalSec: number; burst: number }
  }>
  workspaceRegistry.load({ workspaces: tenants })
  const wsCount = tenants.length || 1
  console.log(`Workspaces loaded: ${wsCount} workspace(s)`)

  // Initialize session manager
  await sessionManager.start()

  // Quarantine Agim Agent JSONL orphans left by /new · switch · META TTL
  // across prior process lifetimes. Best-effort; never blocks boot.
  try {
    const { inventoryAndQuarantineOrphans } = await import('../core/agim-agent-session-lifecycle.js')
    void inventoryAndQuarantineOrphans().catch(() => { /* logged inside */ })
  } catch { /* ignore */ }

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
        const { announceTimeoutDefaultIfAllow } = await import('../core/approval-bus.js')
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
  // Fail-loud sandbox / FS / auto-approve banner — independent of the
  // approval bus so AGIM_APPROVAL_DISABLED=1 still surfaces unconfined exec.
  try {
    const { announceSecurityPosture } = await import('../core/security-posture.js')
    announceSecurityPosture()
  } catch { /* best-effort */ }
  // Wire the bus's lifetime counters into /api/metrics (M14). Done even
  // when the bus failed to start — getMetrics() returns zeros, which is
  // the correct Prometheus snapshot for "no approvals processed".
  const { setApprovalBusSnapshotProvider } = await import('../core/metrics.js')
  setApprovalBusSnapshotProvider(() => approvalBus.getMetrics())

  // Load plugins FIRST (agents won't be registered until this runs)
  await registry.loadBuiltInPlugins()

  // Native LLM + MCP boot — populate the in-process registries from
  // config.json + ~/.agim/llm-secrets.json. Without this, `native`
  // isAvailable() is always false even when llmBackends are configured.
  try {
    const { resolveCliLang, t: cliT } = await import('../cli-ui/i18n.js')
    const bootLang = resolveCliLang()
    const { loadFromConfig: loadLlmFromConfig } = await import('../core/llm/registry.js')
    loadLlmFromConfig(validatedConfig)
    const { loadFromConfig: loadMcpFromConfig, connectAll } = await import('../core/llm/mcp-registry.js')
    await loadMcpFromConfig(validatedConfig as { mcpServers?: unknown })
    const mcpSummary = await connectAll()
    if (mcpSummary.ok.length > 0) {
      console.log(`✅ ${cliT(bootLang, 'start.mcp_connected', { servers: mcpSummary.ok.join(', '), toolCount: mcpSummary.toolCount })}`)
    }
    if (Object.keys(mcpSummary.failed).length > 0) {
      console.warn(`⚠️ ${cliT(bootLang, 'start.mcp_connect_failures', { failures: JSON.stringify(mcpSummary.failed) })}`)
    }
    const { describeNativeAgent } = await import('../plugins/agents/agim-agent-shared/index.js')
    console.log(`🤖 ${cliT(bootLang, 'start.native_agent', { desc: describeNativeAgent() })}`)
  } catch (err) {
    const { resolveCliLang, t: cliT } = await import('../cli-ui/i18n.js')
    const bootLang = resolveCliLang()
    console.warn(`⚠️ ${cliT(bootLang, 'start.native_boot_failed', { message: err instanceof Error ? err.message : String(err) })}`)
  }

  // v1.2.97 — start the local RPC bridge so bgjob-spawned Python (or
  // any-language) scripts can call back into agim's tool surface via
  // a Unix socket. Best-effort: a failure logs at warn but doesn't
  // abort startup. Sub-scripts that try to use the bridge with no
  // server up will refuse to construct an RPC client at import time.
  try {
    const { startRpcServer } = await import('../core/llm/agim-rpc-server.js')
    const s = await startRpcServer()
    if (s) console.log('✅ Local RPC bridge ready (bgjob / static-token services → agim RPC)')
  } catch (err) {
    console.warn('⚠️  agim RPC bridge failed to start:',
      err instanceof Error ? err.message : String(err))
  }

  // Bootstrap per-agent IM workspaces. Idempotent — creates
  // ~/.agim-workspaces/<agent>/ and seeds CLAUDE.md / AGENTS.md only if
  // they don't exist yet. See docs/architecture/agent-cwd-and-memory.md.
  try {
    const bootstrapped = await bootstrapAgentWorkspaces()
    const { resolveCliLang, t: cliT } = await import('../cli-ui/i18n.js')
    const bootLang = resolveCliLang()
    for (const { agent, dir } of bootstrapped) {
      console.log(`📁 ${cliT(bootLang, 'start.agent_workspace', { agent, dir })}`)
    }
    const bgjobPath = ensureBgjobInstalled()
    if (bgjobPath) {
      console.log(`🔧 bgjob → ${bgjobPath}`)
    }
    const { startBgjobWatch } = await import('../core/bgjob-watch.js')
    startBgjobWatch()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const { resolveCliLang, t: cliT } = await import('../cli-ui/i18n.js')
    const bootLang = resolveCliLang()
    console.warn(`⚠️ ${cliT(bootLang, 'start.workspace_boot_failed', { message: msg })}`)
    console.warn(`   ${cliT(bootLang, 'start.workspace_fallback')}`)
  }

  // Start the scheduler (runs cron-due schedules every 30s)
  const { startScheduler } = await import('../core/schedule.js')
  startScheduler()

  // Start the reminder engine (one-shot lightweight timers, 5s tick)
  const { startReminderEngine } = await import('../core/reminders.js')
  startReminderEngine()

  // Start the memo expiry sweeper (every 5 min — purges memos with
  // expires_at <= now). Idempotent: safe even if startSweepTimer is
  // called twice. Lazy import keeps memos.ts out of the cold-start path
  // until it's actually needed.
  const { startSweepTimer: startMemoSweep } = await import('../core/memos.js')
  startMemoSweep()

  // Built-in whisper.cpp: silently install official whisper-cli prebuild
  // (Linux/Windows) + prefetch ggml-base.bin when local STT is likely.
  // Never blocks boot; first transcription still ensures runtime if needed.
  try {
    const { startWhisperModelWarmup } = await import('../core/transcribe-whispercpp-resolve.js')
    startWhisperModelWarmup()
  } catch { /* best-effort */ }

  // Startup diagnostic: IM admin registry summary (admins + known IM users).
  // The registry is now file-based and managed from Web Settings → Admins.
  try {
    const { logStartupResolution } = await import('../core/admin-allowlist.js')
    logStartupResolution()
  } catch { /* best-effort */ }

  // v1.2.66 — sender allowlist startup log. Emits OPEN_IM_ACCESS
  // warning when no list is configured (default-open mode).
  try {
    const { logStartupResolution: logSenderResolution } = await import('../core/sender-allowlist.js')
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
    const { ENV_FILE } = await import('../cli-ui/env-file.js')
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

  // Check messengers BEFORE the default fill.
  // Web-console-only (empty messengers) is a supported first-run shape —
  // match non-TTY / `agim go`. Do NOT force the IM wizard on TTY `start`
  // (that contradicted README "no IM first" and exited on cancel).
  const onboardingResult = checkMessengerConfig(config)
  if (onboardingResult.needsOnboarding) {
    console.log('ℹ️ No messengers configured — running in web-console-only mode.')
    console.log('   Configure later with: agim config <wechat|feishu|dingtalk>')
    if (process.stdin.isTTY) {
      const { yesNo, UserAbortError } = await import('../cli-ui/prompts.js')
      try {
        const wantIm = await yesNo({
          message: 'Configure an IM messenger now? (optional)',
          default: false,
        })
        if (wantIm) {
          const newConfig = await runMessengerOnboarding(config)
          if (newConfig) {
            config = await saveConfigChanges(config, newConfig)
          } else {
            console.log('   Skipped IM setup — continuing with web console only.')
          }
        }
      } catch (err) {
        if (err instanceof (await import('../cli-ui/prompts.js')).UserAbortError) {
          console.log('   Continuing with web console only.')
        } else {
          throw err
        }
      }
    }
  }

  // Check agents (async, AFTER plugins loaded)
  const agentResult = await checkAgentAvailability()
  if (agentResult.allMissing) {
    {
      const { resolveCliLang, t: cliT, formatAgentInstallHint: fmtHint } = await import('../cli-ui/i18n.js')
      const bootLang = resolveCliLang()
      console.log(`\n⚠️ ${cliT(bootLang, 'start.no_agents')}`)
      console.log(fmtHint(bootLang, agentResult.missing))
      console.log(`\n${cliT(bootLang, 'start.install_one_agent')}`)
    }
    process.exit(1)
  } else if (agentResult.missing.length > 0) {
    {
      const { resolveCliLang, t: cliT, formatAgentInstallHint: fmtHint } = await import('../cli-ui/i18n.js')
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
    const { setBootPhase } = await import('../core/boot-state.js')
    setBootPhase('messengers_loading')
  } catch { /* ignore */ }

  // Register the recovery-button executor. When a user taps "🔁 重发" on
  // a recovery card, job-recovery creates the replacement row + invokes
  // this callback to actually run the agent. Without this the button
  // creates an orphan inline-job that never executes.
  try {
    const { setRecoveryExecutor } = await import('../core/job-recovery.js')
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
      await handleInboundMessage(ctx, config.defaultAgent)
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
      await import('../core/job-recovery.js')
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

  // Create the runtime context before starting servers so the
  // gracefulShutdown handler can close them even if startup is
  // interrupted between the two server.listen calls.
  const ctx: StartRuntimeContext = {
    shuttingDown: false,
    shutdownExitCode: 0,
    webServer: undefined,
  }

  let webServer: { close: () => void; port: number } | undefined
  try {
    webServer = await startWebServer({
      port: config.webPort as number | undefined,
      defaultAgent: config.defaultAgent,
    })
    ctx.webServer = webServer
    try {
      const { setBootPhase } = await import('../core/boot-state.js')
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
    const { startMemoryConsolidator } = await import('../core/memory-consolidate.js')
    startMemoryConsolidator()
  } catch (err) {
    console.warn('Memory consolidator failed to start:', err instanceof Error ? err.message : String(err))
  }

  // P1 — dream distillation. Background pass that batch-extracts the turns
  // buffered on the hot path when the system is idle (or past the staleness
  // floor). No-op when AGIM_MEMORY_ENABLED != 1.
  try {
    const { startMemoryDistiller } = await import('../core/memory-distiller.js')
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
    const { getViewerConfig } = await import('../core/viewer-config.js')
    const { startTunnel, findCloudflared } = await import('../core/tunnel.js')
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

  console.log('\n✅ 服务已启动！')
  if (ctx.webServer) {
    console.log(`   Web 控制台：http://localhost:${ctx.webServer.port}`)
  }
  console.log('按 Ctrl+C 停止')

  // v1.5 — flip boot phase to 'ready' so the web restart-polling UI
  // can wait for full readiness instead of merely "HTTP server up".
  try {
    const { setBootPhase, getBootInfo } = await import('../core/boot-state.js')
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
    const { isMemoryEnabled } = await import('../core/persona.js')
    if (isMemoryEnabled()) {
      const { getActiveBackend } = await import('../core/memory-vector.js')
      getActiveBackend()  // constructor → autowarm
    }
  } catch { /* ignore */ }

  // If we came back from a `/restart`, the previous instance dropped a
  // ~/.agim/restart-pending.json with the initiator's IM thread. Now
  // that messengers + agents are all up, push the completion message
  // (or warning) back to that thread and delete the file. Fire and
  // forget — never block startup on this.
  try {
    const { processRestartPending } = await import('../core/restart-completion.js')
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
  requestFatalShutdown = () => { void gracefulShutdown(ctx, 'uncaughtException', 1) }
  process.on('SIGINT', () => { void gracefulShutdown(ctx, 'SIGINT') })
  process.on('SIGTERM', () => { void gracefulShutdown(ctx, 'SIGTERM') })

  // Wait forever
  await new Promise(() => {})
}
