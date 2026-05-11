#!/usr/bin/env node
// im-hub-pro CLI
//
// NOTE: brand string "im-hub-pro" is user-visible (CLI program name, console
// banners, help text). On-disk paths (~/.im-hub/, ~/.im-hub-workspaces/),
// env vars (IMHUB_*), and HTTP headers (X-IM-Hub-Token) intentionally
// retain the legacy "im-hub" identifier for drop-in compatibility with
// existing installations. Do not "fix" them.

import { program } from 'commander'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { registry } from './core/registry.js'
import { sessionManager } from './core/session.js'
import { parseMessage, routeMessage, type RouteContext } from './core/router.js'
import { crossSpawn, isMac, isWindows } from './utils/cross-platform.js'
import type { MessageContext } from './core/types.js'
import { generateTraceId, createLogger } from './core/logger.js'
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
import {
  checkMessengerConfig,
  checkAgentAvailability,
  runMessengerOnboarding,
  formatAgentInstallHint,
  formatMessengerStartError,
  loadConfig as loadOnboardingConfig,
  saveConfig as saveOnboardingConfig,
  type Config as OnboardingConfig,
} from './core/onboarding.js'
import { startWebServer } from './web/server.js'
import { startACPServer } from './core/acp-server.js'

// Helper to format agent install hint for missing agents
function _formatMissingAgentHint(missing: string[]): string {
  return formatAgentInstallHint(missing)
}

const CONFIG_DIR = join(homedir(), '.im-hub')
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
  .name('im-hub-pro')
  .description('Universal messenger-to-agent bridge')
  .version(readPackageVersion())

program
  .command('start')
  .description('Start the im-hub-pro server')
  .action(async () => {
    console.log('🚀 Starting im-hub-pro...')

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
      console.warn('   im-hub-pro will continue with defaults for invalid fields.\n')
    }
    config = validation.config as unknown as Config

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
    if (process.env.IMHUB_APPROVAL_DISABLED === '1') {
      console.log('🛑 Approval bus disabled via IMHUB_APPROVAL_DISABLED=1')
    } else {
      try {
        const sockPath = await approvalBus.start()
        console.log(`✅ Approval bus listening on ${sockPath}`)
        // Expose the path through env so long-lived child processes
        // (notably `opencode serve`, which spawns the MCP sidecar with
        // `env: process.env`) can connect without per-spawn config.
        // claude-code and opencode stdio still set this per-spawn via
        // extraEnv — that override wins inside their spawn scope.
        process.env.IMHUB_APPROVAL_SOCK = sockPath
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

    // Bootstrap per-agent IM workspaces. Idempotent — creates
    // ~/.im-hub-workspaces/<agent>/ and seeds CLAUDE.md / AGENTS.md only if
    // they don't exist yet. See docs/architecture/agent-cwd-and-memory.md.
    try {
      const bootstrapped = await bootstrapAgentWorkspaces()
      for (const { agent, dir } of bootstrapped) {
        console.log(`📁 Agent workspace: ${agent} → ${dir}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`⚠️ Agent workspace bootstrap failed: ${msg}`)
      console.warn('   Agents will fall back to im-hub-pro cwd ("/" under systemd)')
    }

    // Register the imhub MCP server in opencode's global config so opencode
    // (stdio mode) can see the reminder tools. Idempotent; quietly skips if
    // opencode isn't installed / no config dir / write fails. HTTP mode
    // can't use this — see ensure-mcp-config.ts comments.
    try {
      const { ensureOpencodeMcpRegistered } = await import('./plugins/agents/opencode/ensure-mcp-config.js')
      const wrote = await ensureOpencodeMcpRegistered()
      if (wrote) console.log('🔧 Registered imhub MCP in opencode global config')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`⚠️ opencode MCP registration skipped: ${msg}`)
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

    // ============================================
    // ONBOARDING CHECKS (before default fill!)
    // ============================================

    // Check messengers BEFORE the default fill
    const onboardingResult = checkMessengerConfig(config)
    if (onboardingResult.needsOnboarding) {
      console.log('👋 No messengers configured.\n')
      const newConfig = await runMessengerOnboarding(config)
      if (!newConfig) {
        console.log('\n❌ Onboarding cancelled.')
        console.log('Run "im-hub-pro config <messenger>" to configure manually.')
        process.exit(1)
      }
      config = newConfig
      await saveConfig(config)
    }

    // Check agents (async, AFTER plugins loaded)
    const agentResult = await checkAgentAvailability()
    if (agentResult.allMissing) {
      console.log('\n⚠️ No coding agents found!')
      console.log(formatAgentInstallHint(agentResult.missing))
      console.log('\nInstall at least one agent, then run im-hub-pro start again.')
      process.exit(1)
    } else if (agentResult.missing.length > 0) {
      console.log('⚠️ Some agents not available:', agentResult.missing.join(', '))
      console.log(`   ${formatAgentInstallHint(agentResult.missing)}`)
      console.log('')
    }

    // Set defaultAgent to first available installed agent
    if (agentResult.available.length > 0) {
      config.defaultAgent = agentResult.available[0]
    }

    // ============================================
    // START MESSENGERS
    // ============================================

    // Get messengers to start (now config.messengers is populated)
    const messengersToStart = config.messengers.length > 0
      ? [...config.messengers]
      : ['wechat-ilink'] // Fallback default

    // Auto-include the email adapter so /remind email ... works without
    // explicit `im-hub-pro config email`. The adapter's start() is fail-soft
    // when SMTP env vars are missing — it stays "registered but disabled"
    // and any actual send call throws a clear "not configured" error.
    if (!messengersToStart.includes('email')) {
      messengersToStart.push('email')
    }

    // Start messenger adapters
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
        ctx.logger.info({ event: 'message.received', text: ctx.message.text.substring(0, 120), userId: ctx.message.userId })

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
            await messenger.sendMessage(ctx.message.threadId, '✅ 已忽略这条提醒建议')
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
              await messenger.sendMessage(ctx.message.threadId,
                `✅ 已创建提醒 #${id}\n   触发：${p.fireAt.toLocaleString()}${recurLine}\n   内容：${p.text}`)
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              await messenger.sendMessage(ctx.message.threadId, `❌ 创建失败：${msg}`)
            }
          }
          ctx.logger.info({ event: 'message.consumed_by_pending_reminder', decision: replyDecision.decision })
          return
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
              await messenger.sendMessage(ctx.message.threadId, detected.reply)
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

    // Reminder confirm notifier — used by reminder-rpc.ts when an agent
    // creates a high-frequency + LLM-polish reminder (those go through a
    // y/n card before landing in the DB). Plain message via the same
    // messenger the agent is talking on.
    setReminderConfirmNotifier(async (ctx, message) => {
      const messenger = registry.getMessenger(platformToMessengerName(ctx.platform))
        ?? registry.getMessenger(ctx.platform)
      if (!messenger) {
        console.warn(`reminder-confirm: no messenger for platform "${ctx.platform}"`)
        return
      }
      await messenger.sendMessage(ctx.threadId, message)
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
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.warn(`⚠️ Web chat server failed to start: ${errMsg}`)
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

    // Keep process alive
    process.on('SIGINT', async () => {
      console.log('\n👋 Shutting down...')
      sessionManager.stop()
      webServer?.close()
      acpServer?.close()

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

      process.exit(0)
    })

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

  // Prefix uses the session's agent at reply time (re-read after routing so
  // a /agent-style switch in this turn is reflected). Lazy so we only hit
  // the session store when we have a result to send.
  const maybePrefix = async (text: string): Promise<string> => {
    const s = await sessionManager.getExistingSession(platform, ctx.channelId, message.threadId)
    const replyAgent = s?.agent || defaultAgent
    if (replyAgent && replyAgent !== defaultAgent) {
      return `[${replyAgent}]\n\n${text}`
    }
    return text
  }

  const stopTyping = async () => {
    if (messenger.sendTyping) {
      try {
        await messenger.sendTyping(message.threadId, false)
      } catch {
        // Ignore typing errors
      }
    }
  }

  // Build route context with trace
  const routeCtx: RouteContext = {
    threadId: message.threadId,
    channelId: ctx.channelId,
    platform,
    defaultAgent,
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
        const stickySession = await sessionManager.getExistingSession(
          platform, ctx.channelId, message.threadId,
        )
        if (resolvedAgent === 'claude-code') {
          let claudeId = stickySession?.claudeSessionId
          if (!claudeId) {
            claudeId = randomUUID()
            await sessionManager.getOrCreateSession(
              platform, ctx.channelId, message.threadId, resolvedAgent,
            )
            await sessionManager.setClaudeSessionId(
              platform, ctx.channelId, message.threadId, claudeId,
            )
          }
          routeCtx.agentSessionId = claudeId
          const willResume = !!stickySession?.claudeSessionPrimed
          routeCtx.agentSessionResume = willResume
          if (!willResume) {
            try {
              await sessionManager.markClaudeSessionPrimed(
                platform, ctx.channelId, message.threadId,
              )
            } catch (err) {
              logger.debug({ err: String(err) }, 'markClaudeSessionPrimed failed')
            }
          }
        } else if (resolvedAgent === 'opencode') {
          const ocId = stickySession?.opencodeSessionId
          if (ocId) {
            routeCtx.agentSessionId = ocId
            routeCtx.agentSessionResume = true
          }
          await sessionManager.getOrCreateSession(
            platform, ctx.channelId, message.threadId, resolvedAgent,
          )
        } else if (resolvedAgent === 'codex') {
          const cxId = stickySession?.codexSessionId
          if (cxId) {
            routeCtx.agentSessionId = cxId
            routeCtx.agentSessionResume = true
          }
          await sessionManager.getOrCreateSession(
            platform, ctx.channelId, message.threadId, resolvedAgent,
          )
        }
      }
    }

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
      await messenger.sendMessage(message.threadId, await maybePrefix(result))
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
        await messenger.sendMessage(message.threadId, await maybePrefix(fullResponse))
        logger.info({ event: 'message.sent', responseLen: fullResponse.length })
      } else {
        logger.warn({ event: 'message.empty_response' })
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error)
    logger.error({ event: 'message.error', error: errMsg })
    await stopTyping()
    if (dismissThinking) {
      try { await dismissThinking() } catch { /* ignore */ }
    }
    try {
      await messenger.sendMessage(message.threadId, '❌ An error occurred processing your message.')
    } catch {
      // Ignore
    }
  }
}

program
  .command('config [component]')
  .description('Configure a messenger or agent')
  .action(async (component?: string) => {
    if (!component) {
      console.log('Available components to configure:')
      console.log('\nMessengers:')
      console.log('  wechat   - WeChat adapter')
      console.log('  telegram - Telegram adapter')
      console.log('  feishu   - Feishu/Lark adapter')
      console.log('  discord  - Discord adapter')
      console.log('\nAgents:')
      console.log('  claude   - Claude Code agent')
      console.log('  codex    - OpenAI Codex CLI agent')
      console.log('  opencode - OpenCode CLI agent')
      console.log('  copilot  - GitHub Copilot CLI agent')
      console.log('\nRemote Agents:')
      console.log('  agent    - Add a remote ACP agent')
      console.log('\nUsage: im-hub-pro config <component>')
      return
    }

    const config = await loadConfig()

    switch (component) {
      case 'wechat': {
        console.log('📱 Configuring WeChat adapter...')
        console.log('Fetching QR code...\n')

        // Import the iLink adapter for QR login
        const { ILinkWeChatAdapter } = await import('./plugins/messengers/wechat/ilink-adapter.js')
        const adapter = new ILinkWeChatAdapter()

        try {
          // Get QR code URL and token
          const { qrUrl, qrToken } = await adapter.startQRLogin()

          console.log('📱 Scan this QR code with WeChat:\n')
          console.log(qrUrl)
          console.log('\n')

          // Poll for login status
          const credentials = await adapter.waitForQRLogin(qrToken, (status) => {
            console.log(`[${new Date().toLocaleTimeString()}] ${status}`)
          })

          if (credentials) {
            console.log(`\n✅ Logged in as ${credentials.userId}`)
            console.log(`   Bot ID: ${credentials.accountId}`)

            // Add wechat-ilink to config
            if (!config.messengers.includes('wechat-ilink')) {
              config.messengers.push('wechat-ilink')
            }
          } else {
            console.log('\n❌ Login failed or timed out')
            return
          }
        } catch (error) {
          console.error('\n❌ Failed to configure WeChat:', error)
          return
        }
        break
      }

      case 'claude': {
        console.log('🤖 Configuring Claude Code agent...')
        // Check if claude CLI is available
        const checkClaude = crossSpawn('claude', ['--version'], { stdio: 'ignore' })
        checkClaude.on('close', (code) => {
          if (code === 0) {
            console.log('✅ Claude Code CLI found!')
          } else {
            console.log('❌ Claude Code CLI not found.')
            console.log('Install with: npm install -g @anthropic-ai/claude-code')
          }
        })
        if (!config.agents.includes('claude-code')) {
          config.agents.push('claude-code')
        }
        config.defaultAgent = 'claude-code'
        break
      }

      case 'codex': {
        console.log('🤖 Configuring Codex agent...')
        const checkCodex = crossSpawn('codex', ['--version'], { stdio: 'ignore' })
        checkCodex.on('close', (code) => {
          if (code === 0) {
            console.log('✅ Codex CLI found!')
          } else {
            console.log('❌ Codex CLI not found.')
            console.log('Install with: npm install -g @openai/codex')
          }
        })
        if (!config.agents.includes('codex')) {
          config.agents.push('codex')
        }
        config.defaultAgent = 'codex'
        break
      }

      case 'telegram': {
        console.log('📱 Configuring Telegram adapter...')
        console.log('To get a bot token:')
        console.log('1. Open Telegram and search for @BotFather')
        console.log('2. Send /newbot and follow instructions')
        console.log('3. Copy the bot token\n')

        const { createInterface } = await import('node:readline')
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        })

        const token = await new Promise<string>((resolve) => {
          rl.question('Enter your bot token: ', (answer) => {
            resolve(answer.trim())
          })
        })

        if (!token) {
          console.log('❌ Bot token is required')
          return
        }

        const channelId = await new Promise<string>((resolve) => {
          rl.question('Enter channel ID (optional, press Enter for default): ', (answer) => {
            resolve(answer.trim() || 'default')
          })
        })

        rl.close()

        config.telegram = { botToken: token, channelId }
        if (!config.messengers.includes('telegram')) {
          config.messengers.push('telegram')
        }

        console.log('✅ Telegram bot token saved')
        console.log(`   Channel ID: ${channelId}`)
        break
      }

      case 'feishu': {
        console.log('📱 Configuring Feishu adapter (WebSocket long polling mode)...')
        console.log('To create a Feishu bot:')
        console.log('1. Go to https://open.feishu.cn/app')
        console.log('2. Create a custom bot app')
        console.log('3. Enable Bot capability')
        console.log('4. Configure event subscriptions (Subscribe to "im.message.receive_v1" event)')
        console.log('5. Go to Permissions management and enable: im:message, im:message.p2p_msg:readonly, im:message:send_as_bot')
        console.log('6. Create a version and publish it')
        console.log('7. Copy App ID and App Secret\n')

        const { createInterface: createRl } = await import('node:readline')
        const feishuRl = createRl({
          input: process.stdin,
          output: process.stdout,
        })

        const appId = await new Promise<string>((resolve) => {
          feishuRl.question('Enter App ID: ', (answer) => {
            resolve(answer.trim())
          })
        })

        const appSecret = await new Promise<string>((resolve) => {
          feishuRl.question('Enter App Secret: ', (answer) => {
            resolve(answer.trim())
          })
        })

        feishuRl.close()

        if (!appId || !appSecret) {
          console.log('❌ App ID and App Secret are required')
          return
        }

        config.feishu = {
          appId,
          appSecret
        }
        if (!config.messengers.includes('feishu')) {
          config.messengers.push('feishu')
        }

        console.log('✅ Feishu bot credentials saved')
        console.log(`\n✅ Using WebSocket long polling mode - no webhook configuration needed!`)
        console.log(`   The bot will automatically connect to Feishu servers.`)
        break
      }

      case 'discord': {
        console.log('📱 Configuring Discord adapter...')
        console.log('To create a Discord bot:')
        console.log('1. Go to https://discord.com/developers/applications')
        console.log('2. Click "New Application" and give it a name')
        console.log('3. Go to "Bot" tab and click "Add Bot"')
        console.log('4. IMPORTANT: Enable "MESSAGE CONTENT INTENT" under Privileged Gateway Intents')
        console.log('5. Click "Reset Token" to get your bot token')
        console.log('6. Use OAuth2 URL Generator to invite the bot to your server\n')

        const { createInterface: createDiscordRl } = await import('node:readline')
        const discordRl = createDiscordRl({
          input: process.stdin,
          output: process.stdout,
        })

        const discordToken = await new Promise<string>((resolve) => {
          discordRl.question('Enter your bot token: ', (answer) => {
            resolve(answer.trim())
          })
        })

        if (!discordToken) {
          console.log('❌ Bot token is required')
          discordRl.close()
          return
        }

        const discordChannelId = await new Promise<string>((resolve) => {
          discordRl.question('Enter channel ID (optional, press Enter for default): ', (answer) => {
            resolve(answer.trim() || 'default')
          })
        })

        const allowedGuilds = await new Promise<string>((resolve) => {
          discordRl.question('Allowed guild IDs (comma-separated, optional): ', (answer) => {
            resolve(answer.trim())
          })
        })

        const allowedChannels = await new Promise<string>((resolve) => {
          discordRl.question('Allowed channel IDs (comma-separated, optional): ', (answer) => {
            resolve(answer.trim())
          })
        })

        discordRl.close()

        config.discord = {
          botToken: discordToken,
          channelId: discordChannelId,
          allowedGuilds: allowedGuilds ? allowedGuilds.split(',').map(s => s.trim()).filter(Boolean) : undefined,
          allowedChannels: allowedChannels ? allowedChannels.split(',').map(s => s.trim()).filter(Boolean) : undefined,
        }
        if (!config.messengers.includes('discord')) {
          config.messengers.push('discord')
        }

        console.log('✅ Discord bot token saved')
        console.log(`   Channel ID: ${discordChannelId}`)
        if (config.discord.allowedGuilds?.length) {
          console.log(`   Allowed guilds: ${config.discord.allowedGuilds.join(', ')}`)
        }
        if (config.discord.allowedChannels?.length) {
          console.log(`   Allowed channels: ${config.discord.allowedChannels.join(', ')}`)
        }
        break
      }

      case 'opencode': {
        console.log('🤖 Configuring OpenCode agent...')
        // Check if opencode CLI is available
        const openCodeAvailable = await new Promise<boolean>((resolve) => {
          const proc = crossSpawn('opencode', ['--version'], { stdio: 'ignore' })
          proc.on('error', () => resolve(false))
          proc.on('close', (code) => resolve(code === 0))
        })
        if (openCodeAvailable) {
          console.log('✅ OpenCode CLI found!')
          console.log('\nTo authenticate, run: opencode auth login')
        } else {
          console.log('❌ OpenCode CLI not found.')
          console.log('Install with: npm i -g opencode-ai@latest')
          console.log('Or visit: https://github.com/anomalyco/opencode')
        }
        if (!config.agents.includes('opencode')) {
          config.agents.push('opencode')
        }
        config.defaultAgent = 'opencode'
        break
      }

      case 'copilot': {
        console.log('🤖 Configuring GitHub Copilot CLI agent...')
        // Check if copilot CLI is available (multiple installation methods)
        const { copilotAdapter } = await import('./plugins/agents/copilot/index.js')
        const copilotAvailable = await copilotAdapter.isAvailable()
        if (copilotAvailable) {
          console.log('✅ GitHub Copilot CLI found!')
        } else {
          console.log('❌ GitHub Copilot CLI not found.')
          console.log('\n安装方式 (选择其一):')
          console.log('  npm i -g @github/copilot')
          console.log('  gh extension install github/gh-copilot')
          if (isMac) {
            console.log('  brew install copilot-cli')
          }
          if (isWindows) {
            console.log('  winget install GitHub.Copilot')
          }
          console.log('  或安装 VS Code Copilot Chat 扩展')
          console.log('\n详情: https://github.com/features/copilot/cli')
        }
        if (!config.agents.includes('copilot')) {
          config.agents.push('copilot')
        }
        config.defaultAgent = 'copilot'
        break
      }

      case 'agent': {
        console.log('🔌 Configuring remote ACP agent...')
        console.log('This adds a remote agent that speaks the Agent Communication Protocol.')
        console.log('ACP is an open standard (https://agentcommunicationprotocol.dev)\n')

        const { createInterface: createAgentRl } = await import('node:readline')
        const agentRl = createAgentRl({ input: process.stdin, output: process.stdout })

        const agentName = await new Promise<string>((resolve) => {
          agentRl.question('Agent name (e.g. openclaw-dev): ', (answer) => resolve(answer.trim()))
        })
        if (!agentName) { console.log('❌ Name is required'); agentRl.close(); return }

        const agentAlias = await new Promise<string>((resolve) => {
          agentRl.question('Aliases, comma-separated (optional): ', (answer) => resolve(answer.trim()))
        })

        const endpoint = await new Promise<string>((resolve) => {
          agentRl.question('ACP endpoint URL (e.g. http://localhost:8080): ', (answer) => resolve(answer.trim()))
        })
        if (!endpoint) { console.log('❌ Endpoint is required'); agentRl.close(); return }

        console.log('\nAuthentication type:')
        console.log('  1. none')
        console.log('  2. apikey')
        console.log('  3. bearer')
        const authTypeInput = await new Promise<string>((resolve) => {
          agentRl.question('Choose (1-3, default: none): ', (answer) => resolve(answer.trim() || '1'))
        })
        const authTypeMap: Record<string, 'none' | 'apikey' | 'bearer'> = { '1': 'none', '2': 'apikey', '3': 'bearer' }
        const authType = authTypeMap[authTypeInput] || 'none'

        let auth: { type: 'none' | 'apikey' | 'bearer'; token?: string } | undefined
        if (authType !== 'none') {
          const token = await new Promise<string>((resolve) => {
            agentRl.question('Auth token: ', (answer) => resolve(answer.trim()))
          })
          if (!token) { console.log('❌ Token is required when auth is enabled'); agentRl.close(); return }
          auth = { type: authType, token }
        }
        agentRl.close()

        // Validate connection
        console.log('\n🔍 Testing connection...')
        const { ACPClient } = await import('./plugins/agents/acp/acp-client.js')
        const testClient = new ACPClient({ name: agentName, endpoint, auth })
        try {
          const manifest = await testClient.fetchManifest()
          console.log(`✅ Connected! Agent: ${manifest.name}`)
          if (manifest.description) console.log(`   ${manifest.description}`)
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          console.log(`⚠️  Connection failed: ${msg}`)
          console.log('   Agent will be saved but may not work until endpoint is available.')
        }

        // Save
        if (!config.acpAgents) config.acpAgents = []
        const existing = config.acpAgents.findIndex(a => a.name === agentName)
        const agentConfig = {
          name: agentName,
          aliases: agentAlias?.split(',').map(s => s.trim()).filter(Boolean) || [],
          endpoint,
          auth,
          enabled: true
        }

        if (existing >= 0) {
          config.acpAgents[existing] = agentConfig
        } else {
          config.acpAgents.push(agentConfig)
        }
        break
      }

      default:
        console.log(`Unknown component: ${component}`)
        console.log('Run "im-hub-pro config" to see available components.')
        return
    }

    await saveConfig(config)
    console.log(`\n✅ Configuration saved to ${CONFIG_FILE}`)
  })

program
  .command('agents')
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
      console.log('Run "im-hub-pro config claude" to configure Claude Code.')
      console.log('Run "im-hub-pro config agent" to add a remote ACP agent.')
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
  .command('messengers')
  .description('List available messengers')
  .action(async () => {
    await registry.loadBuiltInPlugins()
    const messengers = registry.listMessengers()
    if (messengers.length === 0) {
      console.log('No messengers registered yet.')
      console.log('Run "im-hub-pro config wechat" to configure WeChat.')
      return
    }
    console.log('📱 Available Messengers:\n')
    for (const name of messengers) {
      console.log(`  ${name}`)
    }
  })

program.parse()
