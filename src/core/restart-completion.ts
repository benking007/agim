// Startup hook — process restart-pending.json left by the previous
// instance. Runs AFTER cli.ts has registered messengers and agents (so
// we can push a completion message back to the initiator's IM thread
// and probe agent health).
//
// Cases:
//   - File missing: nothing to do (fresh start, not a restart).
//   - File present, stale (> 5 min): garbage-collect, no push.
//   - File present, fresh, all health checks pass: push "✅ 已重启" + delete file.
//   - File present, restart-failed.log says something blew up: push "⚠️
//     上次重启 X 失败：<reason>，已自动启动" + delete file + truncate fail log.

import { existsSync, readFileSync, unlinkSync, statSync } from 'node:fs'
import { registry } from './registry.js'
import { isAgentAvailableCached } from './onboarding.js'
import { logger as rootLogger } from './logger.js'
import {
  RESTART_PENDING_FILE,
  RESTART_FAILED_LOG,
  type PendingState,
  type RestartInitiator,
} from './restart-flow.js'

const log = rootLogger.child({ component: 'restart-completion' })

const STALE_AFTER_MS = 5 * 60_000

export async function processRestartPending(defaultAgent: string): Promise<void> {
  if (!existsSync(RESTART_PENDING_FILE)) return

  let state: PendingState
  try {
    const raw = readFileSync(RESTART_PENDING_FILE, 'utf-8')
    state = JSON.parse(raw) as PendingState
  } catch (err) {
    log.warn({ event: 'restart-completion.parse_failed', err: String(err) },
      'restart-pending.json corrupt; deleting')
    safeUnlink(RESTART_PENDING_FILE)
    return
  }

  const age = Date.now() - state.started_at
  if (age > STALE_AFTER_MS) {
    log.warn({ event: 'restart-completion.stale', age_ms: age },
      'restart-pending.json is older than 5 min; assuming abandoned, deleting')
    safeUnlink(RESTART_PENDING_FILE)
    return
  }

  // Run self-health.
  const health = await selfHealthCheck(defaultAgent)
  const elapsedSec = (age / 1000).toFixed(1)

  // Was the previous helper able to spawn us, or did something go wrong?
  let failHint = ''
  if (existsSync(RESTART_FAILED_LOG)) {
    try {
      const tail = readFileSync(RESTART_FAILED_LOG, 'utf-8').trim().split('\n').slice(-1)[0]
      if (tail) failHint = ` 上次出错记录：${tail.slice(0, 200)}`
      // Truncate so it doesn't pile up.
      safeUnlink(RESTART_FAILED_LOG)
    } catch { /* ignore */ }
  }

  let body: string
  if (health.ok) {
    body =
      `✅ 已重启完成（耗时 ${elapsedSec}s，pid ${process.pid}，版本 ${state.prev_version}）。\n` +
      health.summary
  } else {
    body =
      `⚠️ 重启完成但有警告（耗时 ${elapsedSec}s，pid ${process.pid}）：\n` +
      health.warnings.map((w, i) => `   ${i + 1}. ${w}`).join('\n') +
      failHint
  }

  await pushToInitiator(state.initiator, body)

  safeUnlink(RESTART_PENDING_FILE)
}

interface HealthResult {
  ok: boolean
  summary: string
  warnings: string[]
}

async function selfHealthCheck(defaultAgent: string): Promise<HealthResult> {
  const warnings: string[] = []
  const lines: string[] = []

  // Default agent must be available — otherwise the bot can't do its
  // primary job. Use the cached probe so we don't double-spawn.
  let agentOk = false
  try {
    agentOk = await isAgentAvailableCached(defaultAgent)
  } catch (err) {
    warnings.push(`默认 agent (${defaultAgent}) 检查失败：${err instanceof Error ? err.message : String(err)}`)
  }
  if (!agentOk) {
    warnings.push(`默认 agent (${defaultAgent}) 不可用 — 收到的消息会路由失败`)
  } else {
    lines.push(`   · agent ${defaultAgent}: ok`)
  }

  // Messengers — list the ones currently registered. Empty list means
  // web-console-only mode, which is fine but worth flagging when an IM
  // initiator was expecting their adapter back.
  const msgs = registry.listMessengers()
  if (msgs.length === 0) {
    warnings.push('当前未注册任何 messenger（web-console-only 模式）')
  } else {
    lines.push(`   · messengers: ${msgs.join(', ')}`)
  }

  return {
    ok: warnings.length === 0,
    summary: lines.join('\n'),
    warnings,
  }
}

async function pushToInitiator(initiator: RestartInitiator, body: string): Promise<void> {
  if (initiator.source !== 'im') {
    // Web / CLI initiator — the caller surface gets its own reply via
    // polling (web) or stdout (cli). Skip the push but log.
    log.info({ event: 'restart-completion.skip_push', source: initiator.source },
      'restart initiator was not an IM thread; skipping completion push')
    return
  }

  if (!initiator.platform || !initiator.threadId) {
    log.warn({ event: 'restart-completion.push_missing_ctx', initiator },
      'IM initiator missing platform/threadId; cannot push completion message')
    return
  }

  const adapter = registry.getMessenger(initiator.platform)
  if (!adapter) {
    log.warn({
      event: 'restart-completion.push_no_messenger',
      platform: initiator.platform,
    }, 'IM messenger not registered after restart; completion push dropped')
    return
  }

  try {
    await adapter.sendMessage(initiator.threadId, body)
    log.info({
      event: 'restart-completion.pushed',
      platform: initiator.platform,
      threadId: initiator.threadId,
    })
  } catch (err) {
    log.warn({
      event: 'restart-completion.push_failed',
      err: err instanceof Error ? err.message : String(err),
      platform: initiator.platform,
    }, 'completion message push threw — dropping')
  }
}

function safeUnlink(p: string): void {
  try { unlinkSync(p) } catch { /* ignore */ }
}

/** Returns true if the running process appears to be inside a restart
 *  (state file exists, fresh). Useful for log lines / startup ordering. */
export function isInsideRestart(): boolean {
  if (!existsSync(RESTART_PENDING_FILE)) return false
  try {
    const st = statSync(RESTART_PENDING_FILE)
    return Date.now() - st.mtimeMs < STALE_AFTER_MS
  } catch {
    return false
  }
}
