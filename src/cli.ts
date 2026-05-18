#!/usr/bin/env node
// Agim (阿吉姆) CLI — rebranded from im-hub-pro at v1.0.0.
//
// Brand: "Agim" (English) / "阿吉姆" (Chinese). Binary is `agim`; the
// legacy `im-hub-pro` bin name is kept as an alias for systemd units +
// shell aliases users have already wired up.
//
// On-disk paths (~/.im-hub/, ~/.im-hub-workspaces/), env vars (IMHUB_*),
// HTTP headers (X-IM-Hub-Token), and the systemd unit `im-hub.service`
// keep their legacy "im-hub" identifier for drop-in compatibility with
// existing installations. Do not "fix" them — millions of bytes of user
// data + every existing deployment's systemd config depend on those
// names being stable. The rename is a brand surface only.

import { program } from 'commander'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { registry } from './core/registry.js'
import { sessionManager } from './core/session.js'
import { runOnThread } from './core/thread-queue.js'
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
import { sink } from './core/message-sink.js'
import {
  createInlineJob, markJobRunning, markJobCompleted, markJobFailed, linkJobOutbox, updateJobAgent,
} from './core/job-board.js'
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
import { AGIM_HOME } from './core/agim-paths.js'

// Helper to format agent install hint for missing agents
function _formatMissingAgentHint(missing: string[]): string {
  return formatAgentInstallHint(missing)
}

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

program
  .command('start')
  .description('Start the Agim server (foreground by default; --bg for detached daemon)')
  .option('--bg, --background', 'Start as a detached background daemon (writes pid file + log to ~/.agim/)')
  .action(async (opts: { bg?: boolean; background?: boolean }) => {
    // `--bg` (or its alias `--background`): hand off to the bg-spawner.
    // It re-execs us with `start` (no flag) inside a detached child so
    // the actual foreground start logic below runs in that child.
    if (opts.bg || opts.background) {
      const { cmdStart } = await import('./cli-ui/cmd-handlers.js')
      await cmdStart(true, async () => { /* unreachable in --bg path */ })
      return
    }
    console.log('🚀 Starting Agim (阿吉姆)…')

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
    // ~/.agim-workspaces/<agent>/ and seeds CLAUDE.md / AGENTS.md only if
    // they don't exist yet. See docs/architecture/agent-cwd-and-memory.md.
    try {
      const bootstrapped = await bootstrapAgentWorkspaces()
      for (const { agent, dir } of bootstrapped) {
        console.log(`📁 Agent workspace: ${agent} → ${dir}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`⚠️ Agent workspace bootstrap failed: ${msg}`)
      console.warn('   Agents will fall back to Agim cwd ("/" under systemd)')
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

    // M-N16 — orphan-artifact sweep (24 h). The common case (job-board
    // retention deletes a row → pruneArtifactsBatch removes the dir) is
    // already covered inline; this catches dirs that survived an unclean
    // shutdown or an older agim version that didn't track them.
    const { startArtifactOrphanSweep } = await import('./core/artifacts.js')
    startArtifactOrphanSweep()

    // First-run admin onboarding: if IMHUB_ADMIN_USERS is unset, write a
    // one-time bootstrap token to ~/.agim/admin-bootstrap-token and print
    // a prominent banner so the operator can self-onboard via
    // `/setup admin <token>` in IM (instead of having to edit env files
    // by hand). On already-configured boxes, this is a no-op that also
    // cleans up any stale token file.
    try {
      const { ensureBootstrapTokenIfNeeded } = await import('./core/admin-bootstrap.js')
      ensureBootstrapTokenIfNeeded()
    } catch (err) {
      console.warn(`⚠️ admin bootstrap setup failed: ${err instanceof Error ? err.message : String(err)}`)
    }

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
        console.log('   Configure later with: agim config <wechat|telegram|feishu|dingtalk|discord>')
      }
    }

    // Check agents (async, AFTER plugins loaded)
    const agentResult = await checkAgentAvailability()
    if (agentResult.allMissing) {
      console.log('\n⚠️ No coding agents found!')
      console.log(formatAgentInstallHint(agentResult.missing))
      console.log('\nInstall at least one agent, then run agim start again.')
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
        ctx.logger.info({ event: 'message.received', text: ctx.message.text.substring(0, 120), userId: ctx.message.userId })

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
              defaultAgent: config.defaultAgent,
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
    // ticks at IMHUB_OUTBOX_TICK_MS (default 1s).
    sink.startWorker()
    console.log('✅ Message-sink worker started')

    // Phase 3 — startup recovery scan. Look at jobs.db for inline rows
    // that got 'interrupted' on the previous shutdown and are still inside
    // the recovery window (default 10 min, env IMHUB_RECOVERY_WINDOW_MS).
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
    // IMHUB_MEMORY_ENABLED != 1.
    try {
      const { startMemoryConsolidator } = await import('./core/memory-consolidate.js')
      startMemoryConsolidator()
    } catch (err) {
      console.warn('Memory consolidator failed to start:', err instanceof Error ? err.message : String(err))
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
    const gracefulShutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return
      shuttingDown = true
      console.log(`\n👋 Received ${signal}, shutting down...`)
      sessionManager.stop()
      webServer?.close()
      acpServer?.close()

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
      try {
        const { stopArtifactOrphanSweep } = await import('./core/artifacts.js')
        stopArtifactOrphanSweep()
      } catch { /* ignore */ }

      process.exit(0)
    }
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

  // Inline-job tracking id (Phase 2). Declared at function scope so the
  // catch block below can mark the row 'failed' on any throw. -1 means
  // "not tracked": either the message didn't reach willInvokeAgent, or
  // createInlineJob fell back to in-memory (DB locked / IMHUB_INLINE_JOB_TRACKING=0).
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

    // Inline-job tracking: every agent-bound inbound message gets a row in
    // the jobs table (kind='inline') so the state machine survives crashes
    // and the Phase 3 startup scan can offer the user a retry. Built-ins
    // (status/audit/router) return string immediately and never touch the
    // agent — no point tracking them. Inline tracking can be killed wholesale
    // via env IMHUB_INLINE_JOB_TRACKING=0 (createInlineJob returns -1, every
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
      // agent fires mcp__imhub__call_agent the bus then knows what
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
        // v1.1.10: string branch is the slash-command path (e.g. /job list,
        // /a2a tree, /outbox status, /restart, /audit). These are
        // operational replies and must stay inline regardless of length —
        // truncating a /job list table behind a viewer link defeats the
        // command. Only the streaming-generator branch below is true
        // freeform agent output and gets source: 'agent'.
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
            source: 'system',
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
  .description('Interactive config wizard (or `config <component>` for the per-component legacy flow)')
  .action(async (component?: string) => {
    if (!component) {
      // New interactive wizard (since v0.5.0). Falls through to the
      // per-component switch below when an explicit `config wechat` etc.
      // is passed — keeps scripted setups working.
      const { pickLang } = await import('./cli-ui/lang-picker.js')
      const { runConfigWizard } = await import('./cli-ui/config-wizard.js')
      const lang = await pickLang()
      await runConfigWizard(lang)
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
        console.log('Run "agim config" to see available components.')
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
  .command('messengers')
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

// ─── service-management commands (v0.5.0) ──────────────────────────────
// status / restart / stop / uninstall — all delegate to cli-ui/cmd-handlers.ts.

program
  .command('status')
  .description('Show whether the bridge is running (systemd / background / foreground)')
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
    const t = createToken(label || '')
    console.log('')
    console.log('✓ New access token created.')
    console.log(`   id    : ${t.id}`)
    console.log(`   label : ${label || '(unlabeled)'}`)
    console.log(`   token : ${t.raw}`)
    console.log('')
    console.log('⚠️ This is the only time the raw value is shown. Save it now.')
    console.log('   Paste it at the /login page or send it as an "Authorization: Bearer <token>" header.')
  })

tokenCmd
  .command('list')
  .description('List existing tokens (no secrets shown)')
  .action(async () => {
    const { listTokens, TOKENS_FILE_PATH } = await import('./core/access-token.js')
    const rows = listTokens()
    console.log(`Stored at: ${TOKENS_FILE_PATH}`)
    if (rows.length === 0) {
      console.log('(no tokens — run `agim token create` to create one)')
      return
    }
    for (const r of rows) {
      const created = new Date(r.created_at * 1000).toISOString().replace('T', ' ').slice(0, 19)
      const lastUsed = r.last_used_at
        ? new Date(r.last_used_at * 1000).toISOString().replace('T', ' ').slice(0, 19)
        : '(never)'
      console.log(`  ${r.id}  label=${r.label}  created=${created}  last_used=${lastUsed}`)
    }
  })

tokenCmd
  .command('revoke <id>')
  .description('Revoke (delete) a token by id')
  .action(async (id: string) => {
    const { revokeToken } = await import('./core/access-token.js')
    const ok = revokeToken(id)
    if (ok) console.log(`✓ token ${id} revoked.`)
    else { console.log(`✗ token ${id} not found.`); process.exit(1) }
  })

// ─── admin allowlist management (v1.2.2+) ───────────────────────────
//
// Non-interactive companion to the entry menu's "邀请新管理员" option.
// Useful from ansible / setup scripts.

const adminCmd = program.command('admin').description('Manage the admin allowlist')

adminCmd
  .command('invite')
  .description('Generate a one-time IM invite token. The invitee runs `/setup admin <token>` to onboard.')
  .action(async () => {
    const { generateAdminInviteToken } = await import('./core/admin-bootstrap.js')
    const { token, file } = generateAdminInviteToken()
    console.log('')
    console.log('✓ Admin invite token generated.')
    console.log(`    token : ${token}`)
    console.log(`    file  : ${file}`)
    console.log('')
    console.log('Forward this to the invitee:')
    console.log(`    /setup admin ${token}`)
    console.log('')
    console.log('⚠️  Single-use. Generating another invite invalidates the previous one.')
  })

adminCmd
  .command('list')
  .description('List current admins (env + runtime-added)')
  .action(async () => {
    // Load ~/.agim/env so IMHUB_ADMIN_USERS is visible when this CLI runs
    // outside the daemon's process env (e.g. fresh shell invoking the CLI
    // directly). The daemon already loads this at start.
    try {
      const { readEnvFile } = await import('./cli-ui/env-file.js')
      const f = readEnvFile()
      if (f.IMHUB_ADMIN_USERS && !process.env.IMHUB_ADMIN_USERS) {
        process.env.IMHUB_ADMIN_USERS = f.IMHUB_ADMIN_USERS
      }
    } catch { /* ignore */ }
    const { listAdmins } = await import('./core/admin-allowlist.js')
    const rows = listAdmins()
    if (rows.length === 0) {
      console.log('(no admins configured — run `agim admin invite` and have the invitee onboard via /setup admin <token>)')
      return
    }
    console.log(`Admins (${rows.length}):`)
    for (const r of rows) console.log(`  ${r.platform}:${r.userId}`)
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
  const { cmdStatus, cmdStart, cmdStop, cmdRestart, cmdUninstall } = await import('./cli-ui/cmd-handlers.js')
  const { action, lang } = await runEntryMenu()
  switch (action.kind) {
    case 'quit':
      return true
    case 'status':
      cmdStatus()
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
    case 'invite_admin': {
      const { generateAdminInviteToken } = await import('./core/admin-bootstrap.js')
      const { t } = await import('./cli-ui/i18n.js')
      const { token, file } = generateAdminInviteToken()
      console.log()
      console.log(t(lang, 'invite_admin.title'))
      console.log()
      console.log(`  ${t(lang, 'invite_admin.generated')} ${token}`)
      console.log()
      console.log(`  ${t(lang, 'invite_admin.howto')}`)
      console.log(`      /setup admin ${token}`)
      console.log()
      console.log(`  ${t(lang, 'invite_admin.note')} ${file}`)
      console.log()
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
