// ws-chat.ts — WebSocket chat handler logic extracted from server.ts.
// Owns: ClientConnection type, webRunAborts registry, message dispatch,
// session history delivery, send helpers, and backpressure drain.

import { randomBytes } from 'node:crypto'
import { type WebSocket } from 'ws'
import { parseMessage, routeMessage, type RouteContext } from '../core/router.js'
import { sessionManager } from '../core/session.js'
import { registry } from '../core/registry.js'
import {
  formatAgentNotAvailableError,
  isAgentAvailableCached,
} from '../core/onboarding.js'
import { expandInlineChannelReply, needsFullInlineDelivery } from '../core/inline-delivery.js'
import { defaultAgentCwd, resolveAgentCwd } from '../core/agent-cwd.js'
import { resolvePortalWorkspacePath } from '../core/workspace-path.js'
import {
  generateTraceId,
  createLogger,
  logger as rootLogger,
  sanitizeUserText,
} from '../core/logger.js'
import { dispatchTurnSteer, threadSteerKey } from '../core/turn-steer.js'
import { isAgimAgentId } from '../core/naming-migrate.js'
import type { ChatMessage } from '../core/types.js'
import { isStepReflectDisabled, isStepReflectEnabled } from '../core/llm/step-reflect.js'
import {
  buildHistoryWireFrames,
  historyUpdatedAt,
  slimActivitySteps,
} from './history-payload.js'

const webLog = rootLogger.child({ component: 'web' })

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ClientConnection {
  ws: WebSocket
  id: string
  agent: string
}

// ─── Module-level state ──────────────────────────────────────────────────────

/** In-flight web chat runs — Stop button aborts the matching controller. */
export const webRunAborts = new Map<string, AbortController>()

export const USER_INTERRUPTED_TEXT = '用户打断了执行'

export function formatWebAgentUnavailableMessage(agentName: string): string {
  if ((agentName === 'native' || agentName === 'agim')) {
    return [
      'Agim Agent is not configured yet.',
      '请粘贴 DeepSeek API Key 一键启用（也可切换其他厂商），或到 /settings/llm 配置。',
    ].join(' ')
  }
  return formatAgentNotAvailableError(agentName)
}

// ─── Send helpers ─────────────────────────────────────────────────────────────

/**
 * Send a JSON message to a WebSocket client
 */
export function sendToClient(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

/** L1: backpressure threshold for the WS send path. When `ws.bufferedAmount`
 *  exceeds this, the streaming chunk loop awaits a tick instead of piling up
 *  more frames. 4 MiB tolerates a few seconds of slow client without
 *  unbounded memory growth — Node's WebSocket impl honors the kernel
 *  send buffer behind this number. */
const WS_BACKPRESSURE_HIGHWATER_BYTES = 4 * 1024 * 1024

/**
 * Wait until `ws.bufferedAmount` drops below the highwater mark, or the
 * socket closes, or the timeout fires. Used by the streaming chunk loop to
 * stop piling up frames at slow clients.
 *
 * Polls every 50 ms — node's `ws` doesn't emit a `drain` event we can hook,
 * but the buffered amount drops monotonically once the kernel ACKs flush.
 * Bounded by AGIM_WS_BACKPRESSURE_TIMEOUT_MS (default 5 s) so a frozen
 * client can't wedge the agent's chunk producer indefinitely.
 */
export async function awaitWsDrain(ws: WebSocket): Promise<void> {
  if (ws.bufferedAmount < WS_BACKPRESSURE_HIGHWATER_BYTES) return
  const timeoutMs = (() => {
    const raw = process.env.AGIM_WS_BACKPRESSURE_TIMEOUT_MS
    if (raw) {
      const n = parseInt(raw, 10)
      if (Number.isFinite(n) && n > 0) return n
    }
    return 5_000
  })()
  const startedAt = Date.now()
  while (
    ws.readyState === ws.OPEN
    && ws.bufferedAmount >= WS_BACKPRESSURE_HIGHWATER_BYTES
    && Date.now() - startedAt < timeoutMs
  ) {
    await new Promise((r) => setTimeout(r, 50))
  }
}

// ─── Session history ──────────────────────────────────────────────────────────

/** Latest durable assistant message id for a web thread (for done → SPA). */
export async function latestWebAssistantMessageId(threadId: string): Promise<string | undefined> {
  try {
    const history = await sessionManager.getSessionWithHistory('web', 'web', threadId)
    if (!history) return undefined
    for (let i = history.messages.length - 1; i >= 0; i--) {
      const m = history.messages[i]
      if (m?.role === 'assistant' && m.id) return m.id
    }
  } catch { /* ignore */ }
  return undefined
}

/**
 * Send session history to a client.
 *
 * Always emit a `history` frame when a session exists — including an empty
 * message list — so the SPA can adopt the sticky agent after MESSAGES_TTL
 * cleared the transcript. Previously we skipped empty histories, which left
 * the agent picker on the process default after refresh.
 *
 * Large transcripts are windowed: the first frame is the newest slice
 * (count + byte budget, activity previews capped). Older turns follow as
 * `history-prepend` so first paint is not one giant JSON.parse + markdown
 * pass. Disk `.log` is unchanged.
 *
 * After history, replay any in-flight (or recently finished) ActiveRun so
 * tab-switch / refresh can restore the activity accordion and "接收中".
 */
export async function sendSessionHistory(
  ws: WebSocket,
  client: ClientConnection,
  _defaultAgent: string,
): Promise<void> {
  // Capture before any await — a later get-history rekey mutates client.id.
  const threadId = client.id
  const history = await sessionManager.getSessionWithHistory('web', 'web', threadId)
  if (history) {
    if (history.session.agent) {
      client.agent = history.session.agent
    }
    const meta = {
      agent: history.session.agent,
      preferredWorkerAgent: history.session.preferredWorkerAgent || '',
      planMode: !!history.session.planMode,
      stepReflect: isStepReflectEnabled(history.session),
      ...(isStepReflectDisabled() ? { stepReflectDisabled: true } : {}),
      thinkVariant: history.session.variant || 'auto',
      sessionModel: history.session.model || '',
      compactRate: history.session.compactRate || 'auto',
      updatedAt: historyUpdatedAt({
        lastActivity: history.session.lastActivity,
        messages: history.messages,
      }),
      threadId,
    }
    let decorate = (m: ChatMessage, absIndex: number): Record<string, unknown> => ({
      ...m,
      serverIndex: absIndex,
    })
    try {
      const { listMessageFeedback, resolveFeedbackVote } = await import('../core/message-feedback.js')
      const feedbackEntries = await listMessageFeedback('web', 'web', threadId)
      decorate = (m, absIndex) => ({
        ...m,
        serverIndex: absIndex,
        feedback: resolveFeedbackVote(feedbackEntries, {
          messageId: m.id,
          messageIndex: absIndex,
        }),
      })
    } catch { /* feedback sidecar optional */ }
    for (const frame of buildHistoryWireFrames(history.messages, meta, decorate)) {
      sendToClient(ws, frame)
    }
  }
  const { getActiveRun } = await import('./active-runs.js')
  const active = getActiveRun(threadId)
  if (active) {
    // Always replay — including finished runs. Sleep/wake often misses
    // `done` while the SPA mid-flight guard also refuses HISTORY; skipping
    // finished active-run then leaves the bubble on stale partial text
    // even though the summary is already on disk / in this snapshot.
    sendToClient(ws, {
      type: 'active-run',
      runId: active.runId,
      agent: active.agent,
      startedAt: new Date(active.startedAt).toISOString(),
      status: active.status,
      steps: slimActivitySteps(active.steps),
      partialText: active.partialText,
      finishedAt: active.finishedAt != null
        ? new Date(active.finishedAt).toISOString()
        : undefined,
      durationMs: active.durationMs,
      error: active.error,
      threadId,
    })
  }
  // Nudge Portal Loop docks to re-fetch GET /api/loop after reconnect /
  // get-history (chat bootstrap does not carry the Loop DTO).
  sendToClient(ws, { type: 'loop-changed', threadId })
}

// ─── Main message dispatcher ──────────────────────────────────────────────────

/**
 * Handle a message from a web client
 */
export async function handleClientMessage(
  client: ClientConnection,
  msg: { type: string; text?: string; agent?: string; threadId?: string; jobId?: number; workspacePath?: string },
  defaultAgent: string,
  /** Notify the caller that the client's id changed mid-handler so the
   *  WS handler can keep its `clients` map in sync when a browser refresh resumes
   *  with its persisted threadId. Without this the approval-card sender (which
   *  does clients.get(threadId)) silently misses the rekeyed client. */
  onRekey?: (oldId: string, newId: string) => void,
  /** R9: token id of the connecting peer (or 'anon' on loopback /
   *  auth-off). Used to enforce thread ownership on get-history rekey. */
  tokenId?: string,
  /** R9: shared threadId → tokenId store (persisted). The handler
   *  validates ownership before adopting a client-supplied threadId. */
  threadOwners?: {
    get(threadId: string): string | undefined
    set(threadId: string, tokenId: string): void
    delete(threadId: string): void
    rekey?(oldId: string, newId: string): void
  },
  /** Live client registry — used to retarget chunk/activity frames after
   *  a reconnect (the closure `ws` may already be CLOSED). */
  clients?: Map<string, ClientConnection>,
): Promise<void> {
  const { ws } = client
  // Read client.id fresh — `get-history` may rekey it mid-handler so the
  // session lookup matches the client's persisted threadId.
  let clientId = client.id

  /** Prefer the currently-connected socket for this thread (post-rekey /
   *  reconnect), falling back to the handler's original `ws`.
   *  Always stamp `threadId` from this handler's captured id so a later
   *  get-history rekey cannot paint this run onto another session. */
  const emit = (data: Record<string, unknown>): void => {
    const live = clients?.get(clientId)
    sendToClient(live?.ws ?? ws, typeof data.threadId === 'string' && data.threadId
      ? data
      : { ...data, threadId: clientId })
  }

  switch (msg.type) {
    case 'message': {
      if (!msg.text?.trim()) return

      const text = msg.text.trim()
      const runId = `run-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
      const runStartedAt = Date.now()
      const traceId = generateTraceId()
      const logger = createLogger({ traceId, platform: 'web', component: 'web' })
      // Stable session key for ActiveRun + live emit (survives WS replace).
      const sessionThreadId = clientId

      if (msg.agent && msg.agent !== client.agent) {
        client.agent = msg.agent
      }

      const parsed = parseMessage(text)

      try {
        const { tryHandleScheduledLoopTurn } = await import('../core/loop-schedule-intent.js')
        const loopCard = await tryHandleScheduledLoopTurn({
          platform: 'web',
          channelId: 'web',
          threadId: sessionThreadId,
          userId: `web:${sessionThreadId}`,
          text,
          surface: 'dock',
        })
        if (loopCard.handled && loopCard.reply) {
          const now = new Date()
          try {
            await sessionManager.addMessage('web', 'web', sessionThreadId, {
              role: 'user', content: text, timestamp: now,
            })
            await sessionManager.addMessage('web', 'web', sessionThreadId, {
              role: 'assistant', content: loopCard.reply, timestamp: now, agent: 'agim',
            })
          } catch { /* best-effort persist */ }
          emit({ type: 'chunk', text: loopCard.reply })
          emit({ type: 'done', text: loopCard.reply })
          return
        }
      } catch (err) {
        logger.warn({
          event: 'loop-schedule-intent.crashed',
          err: err instanceof Error ? err.message : String(err),
        }, 'scheduled-loop detector crashed — falling through')
      }

      // Agent-switch command (/agim, /cc, /pi, …): routeMessage persists
      // the session switch, but the WS client + the chat dropdown only learn
      // about a switch via the explicit `switch-agent` path. Mirror it here so
      // a command switch keeps the picker in sync. Gated on availability like
      // the switch-agent handler so we don't advertise an unusable agent.
      if (parsed.type === 'agent') {
        const sw = registry.findAgent(parsed.agent)
        if (sw && sw.name !== client.agent && (await isAgentAvailableCached(sw.name))) {
          client.agent = sw.name
          emit({ type: 'agent-switched', agent: sw.name })
        }
      }

      const {
        startActiveRun,
        upsertActiveRunStep,
        appendActiveRunChunk,
        setActiveRunPartialText,
        finishActiveRun,
        getActiveRun,
        snapshotToPersistedActivity,
      } = await import('./active-runs.js')

      const persistFinishedActivity = async (matchContent?: string): Promise<void> => {
        const snap = getActiveRun(sessionThreadId)
        if (!snap || snap.status === 'running') return
        // Persist even with empty steps so "已完成 · Xs" survives refresh.
        const activity = snapshotToPersistedActivity(snap)
        try {
          let ok = await sessionManager.patchLastAssistantActivity(
            'web', 'web', sessionThreadId, activity, matchContent,
          )
          if (!ok && matchContent !== undefined) {
            ok = await sessionManager.patchLastAssistantActivity(
              'web', 'web', sessionThreadId, activity,
            )
          }
          if (!ok) {
            webLog.warn({
              event: 'web.activity.persist_miss',
              threadId: sessionThreadId,
              runId: snap.runId,
            }, 'No assistant message to attach activity to')
          }
        } catch (err) {
          webLog.warn({
            event: 'web.activity.persist_failed',
            threadId: sessionThreadId,
            err: err instanceof Error ? err.message : String(err),
          }, 'Failed to persist chat activity')
        }
      }

      startActiveRun({
        threadId: sessionThreadId,
        runId,
        agent: client.agent,
        startedAt: runStartedAt,
      })
      emit({
        type: 'run-start',
        runId,
        agent: client.agent,
        startedAt: new Date(runStartedAt).toISOString(),
      })

      // Abort any previous in-flight run on this thread, then bind a fresh
      // controller so the Stop button (WS `stop`) can interrupt the CLI.
      webRunAborts.get(sessionThreadId)?.abort()
      const runAbort = new AbortController()
      webRunAborts.set(sessionThreadId, runAbort)
      const onParentAbort = (): void => {
        void import('../core/job-board.js').then(({ abortChildJobsForParentTurn }) => {
          abortChildJobsForParentTurn(
            'web',
            'web',
            sessionThreadId,
            'cancelled: parent turn aborted',
          )
        }).catch(() => { /* job board optional */ })
      }
      runAbort.signal.addEventListener('abort', onParentAbort, { once: true })

      try {
        const workspacePath = resolvePortalWorkspacePath(msg.workspacePath, client.agent)
        const routeCtx: RouteContext = {
          threadId: clientId,
          channelId: 'web',
          platform: 'web',
          defaultAgent: client.agent,
          traceId,
          logger,
          userId: `web:${clientId}`,
          webRunId: runId,
          ...(workspacePath ? { workspacePath } : {}),
          signal: runAbort.signal,
          onToolActivity: (step) => {
            const applied = upsertActiveRunStep(sessionThreadId, {
              id: step.id,
              kind: step.kind,
              label: step.label,
              status: step.status,
              startedAt: step.startedAt,
              finishedAt: step.finishedAt,
              preview: step.preview,
              ...(step.todoItems ? { todoItems: step.todoItems } : {}),
              ...(typeof step.jobId === 'number' ? { jobId: step.jobId } : {}),
              ...(step.reflects ? { reflects: step.reflects } : {}),
              ...(step.lastTool ? { lastTool: step.lastTool } : {}),
            })
            if (!applied) return
            const snap = getActiveRun(sessionThreadId)
            if (!snap) return
            // Running turns always stream. After finishActiveRun, still
            // emit terminal Subagent updates so cards don't stay Waiting.
            if (snap.status !== 'running' && step.kind !== 'agent') return
            emit({ type: 'activity-step', runId: snap.runId, step })
            if (snap.status !== 'running') {
              void persistFinishedActivity()
            }
          },
        }

        logger.info({ event: 'message.received', ...sanitizeUserText(text) })

        const result = await routeMessage(parsed, routeCtx)

        if (runAbort.signal.aborted) {
          const finishedAt = Date.now()
          const durationMs = Math.max(0, finishedAt - runStartedAt)
          finishActiveRun(sessionThreadId, {
            status: 'error', finishedAt, durationMs, error: USER_INTERRUPTED_TEXT,
          })
          try {
            await sessionManager.addMessage('web', 'web', sessionThreadId, {
              role: 'assistant',
              content: USER_INTERRUPTED_TEXT,
              agent: client.agent,
              timestamp: new Date(),
            })
          } catch { /* best-effort */ }
          await persistFinishedActivity(USER_INTERRUPTED_TEXT)
          emit({
            type: 'done',
            text: USER_INTERRUPTED_TEXT,
            runId,
            messageId: await latestWebAssistantMessageId(sessionThreadId),
          })
          emit({
            type: 'run-finish',
            runId,
            status: 'error',
            finishedAt: new Date(finishedAt).toISOString(),
            durationMs,
            error: USER_INTERRUPTED_TEXT,
          })
          return
        }

        // String response (built-in commands, errors)
        if (typeof result === 'string') {
          const finishedAt = Date.now()
          const durationMs = Math.max(0, finishedAt - runStartedAt)
          setActiveRunPartialText(sessionThreadId, result)
          finishActiveRun(sessionThreadId, {
            status: 'success', finishedAt, durationMs, finalText: result,
          })
          await persistFinishedActivity(result)
          emit({
            type: 'done',
            text: result,
            runId,
            messageId: await latestWebAssistantMessageId(sessionThreadId),
          })
          if (parsed.type === 'plan') {
            const sess = await sessionManager.getExistingSession('web', 'web', sessionThreadId)
            emit({ type: 'plan-mode', enabled: !!sess?.planMode })
          }
          if (parsed.type === 'step-reflect') {
            const sess = await sessionManager.getExistingSession('web', 'web', sessionThreadId)
            emit({
              type: 'step-reflect-mode',
              enabled: isStepReflectEnabled(sess),
              ...(isStepReflectDisabled() ? { disabled: true } : {}),
            })
          }
          if (parsed.type === 'think') {
            const sess = await sessionManager.getExistingSession('web', 'web', sessionThreadId)
            emit({ type: 'think-mode', variant: sess?.variant || 'auto' })
          }
          if (parsed.type === 'ctx') {
            const sess = await sessionManager.getExistingSession('web', 'web', sessionThreadId)
            emit({ type: 'compact-rate', rate: sess?.compactRate || 'auto' })
          }
          if (parsed.type === 'model') {
            const sess = await sessionManager.getExistingSession('web', 'web', sessionThreadId)
            emit({ type: 'session-model', model: sess?.model || '' })
          }
          emit({
            type: 'usage',
            runId,
            durationMs,
            outputChars: result.length,
          })
          emit({
            type: 'run-finish',
            runId,
            status: 'success',
            finishedAt: new Date(finishedAt).toISOString(),
            durationMs,
          })
          return
        }

        // Streaming response (agent responses)
        let fullText = ''
        for await (const chunk of result) {
          if (runAbort.signal.aborted) break
          fullText += chunk
          appendActiveRunChunk(sessionThreadId, chunk)
          // L1: defer when the per-socket send buffer is full. Without
          // this, a slow client lets the chunk producer keep allocating
          // frames into the kernel + ws-internal queue, which can grow
          // to GBs for a long agent response.
          const liveWs = clients?.get(sessionThreadId)?.ws ?? ws
          await awaitWsDrain(liveWs)
          // Keep producing even if the original socket died — a reconnect
          // may have registered under sessionThreadId. Only stop if there
          // is still no live peer AND the original is closed (avoid
          // unbounded buffering into ActiveRun alone for hours).
          const peer = clients?.get(sessionThreadId)
          if (!peer && liveWs.readyState !== liveWs.OPEN) break
          if (peer) emit({ type: 'chunk', text: chunk, runId })
          else if (liveWs.readyState === liveWs.OPEN) emit({ type: 'chunk', text: chunk, runId })
        }

        if (runAbort.signal.aborted) {
          const finishedAt = Date.now()
          const durationMs = Math.max(0, finishedAt - runStartedAt)
          const text = fullText.trim()
            ? `${fullText.trimEnd()}\n\n${USER_INTERRUPTED_TEXT}`
            : USER_INTERRUPTED_TEXT
          setActiveRunPartialText(sessionThreadId, text)
          finishActiveRun(sessionThreadId, {
            status: 'error', finishedAt, durationMs, error: USER_INTERRUPTED_TEXT, finalText: text,
          })
          await persistFinishedActivity(text)
          emit({
            type: 'done',
            text,
            runId,
            messageId: await latestWebAssistantMessageId(sessionThreadId),
          })
          emit({
            type: 'run-finish',
            runId,
            status: 'error',
            finishedAt: new Date(finishedAt).toISOString(),
            durationMs,
            error: USER_INTERRUPTED_TEXT,
          })
          return
        }

        const finishedAt = Date.now()
        const durationMs = Math.max(0, finishedAt - runStartedAt)
        // Hard constraint: Web / Portal (/m/chat, macOS·iOS shells) never
        // deliver summary-only (envelope or 落盘+要点). SPA replaces the
        // streamed bubble with done.text.
        let deliveredText = fullText
        if (needsFullInlineDelivery('web') && fullText.trim()) {
          const cwd = resolveAgentCwd(client.agent, {
            platform: 'web',
            channelId: 'web',
            threadId: sessionThreadId,
            ...(workspacePath ? { workspacePath } : {}),
          }) || defaultAgentCwd(client.agent)
          deliveredText = expandInlineChannelReply(fullText, { workspaceRoot: cwd })
        }
        setActiveRunPartialText(sessionThreadId, deliveredText)
        finishActiveRun(sessionThreadId, {
          status: 'success', finishedAt, durationMs, finalText: deliveredText,
        })
        await persistFinishedActivity(deliveredText)
        emit({
          type: 'done',
          text: deliveredText,
          runId,
          messageId: await latestWebAssistantMessageId(sessionThreadId),
        })
        emit({
          type: 'usage',
          runId,
          durationMs,
          outputChars: deliveredText.length,
        })
        emit({
          type: 'run-finish',
          runId,
          status: 'success',
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs,
        })
      } catch (err) {
        const aborted = runAbort.signal.aborted
          || (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message)))
        const errorMsg = aborted
          ? USER_INTERRUPTED_TEXT
          : (err instanceof Error ? err.message : String(err))
        const stack = err instanceof Error ? err.stack : undefined
        if (!aborted) {
          logger.error({ event: 'web.handle.error', err: errorMsg, stack }, 'Error handling client message')
        } else {
          logger.info({ event: 'web.handle.aborted', runId }, 'Web chat run aborted by user')
        }
        const finishedAt = Date.now()
        const durationMs = Math.max(0, finishedAt - runStartedAt)
        finishActiveRun(sessionThreadId, {
          status: 'error', finishedAt, durationMs, error: errorMsg,
        })
        if (aborted) {
          try {
            await sessionManager.addMessage('web', 'web', sessionThreadId, {
              role: 'assistant',
              content: USER_INTERRUPTED_TEXT,
              agent: client.agent,
              timestamp: new Date(),
            })
          } catch { /* best-effort */ }
          await persistFinishedActivity(USER_INTERRUPTED_TEXT)
          emit({
            type: 'done',
            text: USER_INTERRUPTED_TEXT,
            runId,
            messageId: await latestWebAssistantMessageId(sessionThreadId),
          })
        } else {
          await persistFinishedActivity()
        }
        emit({
          type: 'run-finish',
          runId,
          status: 'error',
          finishedAt: new Date(finishedAt).toISOString(),
          durationMs,
          error: errorMsg,
        })
        if (!aborted) emit({ type: 'error', message: `Agent error: ${errorMsg}` })
      } finally {
        if (webRunAborts.get(sessionThreadId) === runAbort) {
          webRunAborts.delete(sessionThreadId)
        }
      }
      break
    }

    case 'stop': {
      const ac = webRunAborts.get(clientId)
      if (!ac) {
        sendToClient(ws, { type: 'error', message: '当前没有正在执行的任务' })
        break
      }
      ac.abort()
      break
    }

    case 'steer': {
      // Mid-turn supplement: persist as a user bubble and inject into the
      // live Agim harness. Must not start a new turn / placeholder.
      const text = msg.text?.trim() ?? ''
      if (!text) break
      if (!webRunAborts.get(clientId)) {
        emit({ type: 'error', message: '当前没有正在执行的任务' })
        break
      }
      if (!isAgimAgentId(client.agent)) {
        emit({ type: 'error', message: '当前 Agent 不支持本轮补充，请等本轮结束后再发，或点终止。' })
        break
      }
      try {
        await sessionManager.addMessage('web', 'web', clientId, {
          role: 'user',
          content: text,
          timestamp: new Date(),
        })
        const mode = await dispatchTurnSteer(threadSteerKey('web', 'web', clientId), text)
        emit({ type: 'steer-accepted', text, mode })
      } catch (err) {
        emit({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
      break
    }

    case 'stop-subagent': {
      // Cancel one A2A/Subagent inline job for this web thread. Parent turn
      // keeps running; callAgentByName returns partial text + summarize brief.
      const jobId = typeof msg.jobId === 'number' ? msg.jobId : Number(msg.jobId)
      if (!Number.isFinite(jobId) || jobId <= 0) {
        sendToClient(ws, { type: 'error', message: 'Invalid Subagent job id' })
        break
      }
      try {
        const { getJob, cancelJob } = await import('../core/job-board.js')
        const job = getJob(jobId)
        if (!job) {
          sendToClient(ws, { type: 'error', message: 'Subagent job not found' })
          break
        }
        const expectedKey = `web:web:${clientId}`
        if (job.thread_key && job.thread_key !== expectedKey) {
          sendToClient(ws, { type: 'error', message: 'Subagent job is not on this thread' })
          break
        }
        const ok = cancelJob(jobId)
        if (!ok) {
          sendToClient(ws, { type: 'error', message: 'Subagent is not running' })
          break
        }
        sendToClient(ws, { type: 'subagent-stopped', jobId })
      } catch (err) {
        sendToClient(ws, {
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
      break
    }

    case 'switch-agent': {
      if (!msg.agent) return
      const agent = registry.findAgent(msg.agent)
      if (!agent) {
        sendToClient(ws, { type: 'error', message: `Agent "${msg.agent}" not found` })
        return
      }
      if (!(await isAgentAvailableCached(agent.name))) {
        sendToClient(ws, {
          type: 'error',
          message: formatWebAgentUnavailableMessage(agent.name),
        })
        return
      }
      client.agent = agent.name
      const session = await sessionManager.switchAgent('web', 'web', clientId, agent.name)
      sendToClient(ws, {
        type: 'agent-switched',
        agent: agent.name,
        preferredWorkerAgent: session.preferredWorkerAgent || '',
      })
      break
    }

    case 'get-agents': {
      const agents = registry.listAgents()
      sendToClient(ws, { type: 'agents', agents })
      break
    }

    case 'get-history': {
      // 2026-05-19: support client-supplied threadId so a browser refresh
      // (or returning to the chat after a navigation) resumes the existing
      // conversation instead of starting fresh. Client persists the id in
      // localStorage; if it provides one, we treat it as the authoritative
      // session key going forward. We update client.id (so subsequent
      // `message` / `switch-agent` ops use the persisted thread) but leave
      // the clients map alone — push-by-clientId is a separate code path
      // that doesn't rely on the persisted id today.
      //
      // R9: before adopting the threadId, validate ownership. The
      // pre-R9 path accepted any well-formed `web-*` id, letting an
      // authenticated peer enumerate Date.now()-based ids and hijack
      // (or wipe via new-conversation) another peer's chat session.
      // Now the threadId is owned by the tokenId that first claimed it;
      // a rekey from a different tokenId is refused.
      const wantedThreadId = typeof msg.threadId === 'string' ? msg.threadId.trim() : ''
      if (wantedThreadId && /^web-[A-Za-z0-9_-]{4,64}$/.test(wantedThreadId) && wantedThreadId !== clientId) {
        const peer = tokenId ?? 'anon'
        const owner = threadOwners?.get(wantedThreadId)
        if (owner !== undefined && owner !== peer) {
          // Stale localStorage from another token (rotated bootstrap,
          // shared browser profile, …). Do NOT hijack that thread —
          // keep this connection's already-claimed clientId and tell
          // the SPA to adopt it as a fresh conversation instead of a
          // hard error that leaves the chat unusable.
          webLog.warn({
            event: 'web.session.rekey_denied',
            clientId, wantedThreadId, peer, owner,
          }, 'WS get-history rekey refused — starting fresh thread for this token')
          sendToClient(ws, {
            type: 'thread-reassigned',
            threadId: clientId,
            reason: 'ownership_mismatch',
          })
          await sendSessionHistory(ws, client, defaultAgent)
          return
        }
        // First-claim OK (owner === undefined) or same-owner reconnect.
        const oldId = clientId
        client.id = wantedThreadId
        clientId = wantedThreadId
        if (threadOwners && owner === undefined) {
          threadOwners.set(wantedThreadId, peer)
        }
        onRekey?.(oldId, wantedThreadId)
        webLog.info({ clientId, oldId, event: 'web.session.rekey' }, 'WS client adopted persisted threadId')
      }
      await sendSessionHistory(ws, client, defaultAgent)
      break
    }

    // v1's "New conversation" button in the web chat. Clears the
    // session messages, forks a fresh session id, drops per-agent CLI
    // session bindings (Claude/opencode/codex) and any auto-allow
    // approval rules, so the next prompt starts on a clean slate. The
    // WS client receives a follow-up `history` message with an empty
    // list so the UI repaints the cleared state.
    case 'set-workspace': {
      const raw = typeof msg.workspacePath === 'string' ? msg.workspacePath : ''
      const resolved = resolvePortalWorkspacePath(raw, client.agent)
      // Prefer getExistingSession so a mere folder bind does not touch
      // lastActivity (which would race get-history and paint "Just now").
      let session = await sessionManager.getExistingSession('web', 'web', clientId)
      if (!session) {
        session = await sessionManager.getOrCreateSession('web', 'web', clientId, client.agent)
      }
      await sessionManager.patchSession(
        'web', 'web', clientId,
        { workspacePath: resolved || '' },
        { touch: false },
      )
      emit({
        type: 'workspace',
        ok: !raw.trim() || !!resolved,
        path: resolved || null,
      })
      break
    }

    case 'new-conversation': {
      const { clearActiveRun } = await import('./active-runs.js')
      clearActiveRun(clientId)
      await sessionManager.resetConversation('web', 'web', clientId)
      sendToClient(ws, {
        type: 'history',
        messages: [],
        agent: client.agent,
        preferredWorkerAgent: '',
        olderCount: 0,
        historyComplete: true,
        threadId: clientId,
      })
      break
    }
  }
}
