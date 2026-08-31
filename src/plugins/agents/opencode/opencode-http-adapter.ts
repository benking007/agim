// OpenCode HTTP driver.
//
// Why this exists:
//   `opencode run --format json` (the stdio driver in opencode-stdio-adapter.ts)
//   does NOT emit `permission.asked` events on its stdout stream, and its
//   inline auto-reject logic occasionally fails to release the prompt
//   deferred — the process then hangs until agim's 30-min hard SIGTERM.
//   Audit confirmed this on 2026-05-04 (rows id=283/284, exact 1,800,000 ms).
//
// What this driver does instead:
//   1. Lazily starts a long-lived `opencode serve` daemon on 127.0.0.1
//      (via OpencodeServeManager). Probes-and-reuses any healthy daemon
//      already on the configured port so back-to-back agim restarts
//      don't bind-fail on a still-running child.
//   2. Subscribes to /event SSE so the adapter — not the run-CLI — owns the
//      authoritative event stream.
//   3. Creates sessions via POST /session and submits prompts via
//      POST /session/:id/message. Resumes existing sessions when
//      opts.agentSessionId is set; on first turn of a resumed session this
//      process lifetime, PATCHes the session ruleset to apply the current
//      gate policy.
//   4. Routes `permission.asked` SSE events through the IM approval bus
//      when an IM context (threadId + platform) and notifier are both
//      available. Decisions translate: allow → opencode `once`, deny →
//      opencode `reject` (with optional message). Without an IM channel
//      the adapter falls back to auto-`once` so non-IM call paths (web,
//      scheduler) keep working.
//   5. Exits cleanly on `session.status: idle` for the right session,
//      surfaces `session.error`, and is bounded by an idle watchdog
//      (OPENCODE_IDLE_TIMEOUT_MS / AGIM_AGENT_IDLE_TIMEOUT_MS, default
//      120 min, 0 = disabled) that fires only when the daemon goes
//      completely silent — slow human approvals don't count.
//
// Selection: env AGIM_OPENCODE_DRIVER=http picks this; anything else (incl
// unset) picks the stdio adapter. See ./index.ts factory.
//
// Gate policy: env AGIM_OPENCODE_GATE controls which permissions surface
// as IM cards. See buildSessionRuleset() for the strict / medium / loose /
// none levels — medium is the default and gates edit / write / patch.
//
// Compatibility: extends OpenCodeAdapter so registry / tests that probe
// `instanceof OpenCodeAdapter` stay green. The base class's spawnStream is
// not used — sendPrompt is overridden end-to-end.

import { OpenCodeAdapter } from './opencode-stdio-adapter.js'
import type { AgentSendOpts, ChatMessage } from '../../../core/types.js'
import { resolveAgentCwd } from '../../../core/agent-cwd.js'
import { logger as rootLogger } from '../../../core/logger.js'
import { type OpencodeServeManager, opencodeServe as defaultServe } from './serve-manager.js'
import { approvalBus as defaultApprovalBus, type ApprovalBus, type Decision } from '../../../core/approval-bus.js'
import { Agent as UndiciAgent } from 'undici'
import { ensureOpencodeMcpRegistered } from './ensure-mcp-config.js'

/**
 * Long-running dispatcher used for the prompt POST.
 *
 * opencode 1.14.45+ blocks `POST /session/:id/message` until the assistant
 * message is fully composed — for tool-heavy or model-heavy turns that
 * routinely exceeds Node's built-in fetch (undici) default 5-minute
 * `bodyTimeout`, surfacing as `TypeError: fetch failed` exactly 300_000 ms
 * after the request was sent. The SSE side (handled separately by
 * openEventStream) already has its own idle watchdog, so disabling the
 * underlying socket timeouts here doesn't reintroduce a hang risk — it
 * just stops undici from preemptively killing a long but healthy response.
 */
const longRunningDispatcher = new UndiciAgent({
  bodyTimeout: 0,
  headersTimeout: 0,
  // keepAliveTimeout matches default; not relevant here but keeps explicit.
  keepAliveTimeout: 4_000,
})

const log = rootLogger.child({ component: 'agent.opencode.http' })

// Idle (no-SSE-event) timeout — matches the semantics in agent-base.ts: the
// watchdog re-arms on every event the daemon emits, so slow human-in-the-loop
// approvals don't count against the budget; only true silence does. Override
// via OPENCODE_IDLE_TIMEOUT_MS or AGIM_AGENT_IDLE_TIMEOUT_MS; set 0 to disable.
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000  // 2 h

/** Shape of an event arriving on opencode's /event SSE stream. Every field
 *  is optional because we are deliberately conservative — opencode's bus is
 *  shared across many event types and we touch only the slice we need. */
interface OpencodePart {
  id?: string
  type?: string
  text?: string
  tokens?: { input?: number; output?: number; total?: number; reasoning?: number }
  cost?: number
  time?: { start?: number; end?: number }
  sessionID?: string
}

/** Shape returned by POST /session/:id/message on opencode 1.14.45+ where the
 *  /event SSE stream silently drops bus events. The endpoint blocks until the
 *  assistant message is complete and returns the full message body. We use it
 *  as the authoritative source of text + usage when SSE yields nothing. */
interface OpencodeMessageResponse {
  info?: {
    id?: string
    sessionID?: string
    cost?: number
    tokens?: { input?: number; output?: number; total?: number; reasoning?: number }
  }
  parts?: OpencodePart[]
}

interface OpencodeEvent {
  type: string
  properties?: {
    sessionID?: string
    info?: { id?: string; status?: { type?: string }; sessionID?: string }
    part?: OpencodePart
    status?: { type?: string }
    error?: unknown
    /** permission.asked carries an id at properties.id (Permission.Request). */
    id?: string
    /** Permission name on permission.asked, e.g. "external_directory" / "bash". */
    permission?: string
    /** Patterns the agent wants to access. */
    patterns?: string[]
    /** Tool-specific metadata that may help the user decide. */
    metadata?: Record<string, unknown>
  }
}

export interface HttpAdapterOptions {
  /** Override the singleton serve manager. Tests inject a mock. */
  serve?: OpencodeServeManager
  /** Override fetch. Tests inject a mock. */
  fetchImpl?: typeof fetch
  /** Override the IM approval bus. Defaults to the process singleton; pass
   *  `null` to disable the bridge entirely (used by tests that want to lock
   *  in the no-bus fallback path). */
  approvalBus?: ApprovalBus | null
  /** Register Agim's MCP sidecar in opencode's own config before starting
   *  `opencode serve`. Tests inject a no-op to avoid touching user config. */
  ensureMcp?: () => Promise<boolean>
}

export class OpenCodeHttpAdapter extends OpenCodeAdapter {
  private readonly serve: OpencodeServeManager
  private readonly fetchImpl: typeof fetch
  private readonly ensureMcp: () => Promise<boolean>
  /** null when the bridge is intentionally disabled. */
  private readonly approvalBus: ApprovalBus | null
  /** Set of opencode session ids whose ruleset we've already PATCHed in this
   *  process lifetime. Lets us re-apply the gate policy when an agim
   *  restart resurfaces an old session, without duplicating rules every
   *  turn. Cleared only by agim restart — that's fine since the rules
   *  the previous run wrote are still in opencode's session DB. */
  private readonly rulesetApplied = new Set<string>()

  constructor(opts: HttpAdapterOptions = {}) {
    super()
    this.serve = opts.serve ?? defaultServe
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.ensureMcp = opts.ensureMcp ?? ensureOpencodeMcpRegistered
    this.approvalBus = opts.approvalBus === null
      ? null
      : (opts.approvalBus ?? defaultApprovalBus)
    log.info({ event: 'opencode.http.driver_selected', bridge: this.approvalBus !== null },
      '[opencode] HTTP driver active (real serve + SSE; IM approval bridge when bus has notifier)')
  }

  /**
   * Translate a single SSE event into adapter-side effects:
   *   - sessionID capture → opts.onAgentSessionId
   *   - step-finish cost/tokens → opts.onUsage
   *   - text-part with finished `time.end` → returned as a chunk (with
   *     part id when known, so the caller can dedupe against the POST-body
   *     fallback for SSE-broken builds — see drainResponseBody).
   * Pure: tests drive this directly without spinning up a daemon.
   */
  inspectHttpEvent(event: OpencodeEvent, sessionID: string, opts: AgentSendOpts): { text?: string; partId?: string } {
    const props = event.properties ?? {}
    const part = props.part

    // sessionID can appear on the event root, on properties, on properties.info
    // or inside part. Bubble up the first one we see — setOpencodeSessionId
    // (the receiver) is idempotent.
    const sid = props.sessionID || part?.sessionID || props.info?.sessionID
    if (sid && opts.onAgentSessionId) {
      try { opts.onAgentSessionId(sid) } catch { /* don't let userland callbacks kill the stream */ }
    }

    if (event.type === 'message.part.updated' && part) {
      if (part.type === 'step-finish') {
        const delta: { costUsd?: number; tokensInput?: number; tokensOutput?: number } = {}
        if (typeof part.cost === 'number' && Number.isFinite(part.cost)) delta.costUsd = part.cost
        if (typeof part.tokens?.input === 'number') delta.tokensInput = part.tokens.input
        if (typeof part.tokens?.output === 'number') delta.tokensOutput = part.tokens.output
        if (delta.costUsd !== undefined || delta.tokensInput !== undefined || delta.tokensOutput !== undefined) {
          if (opts.onUsage) {
            try { opts.onUsage(delta) } catch { /* same — user callback safety */ }
          }
        }
      }

      // Match the stdio adapter: only yield text once the part is fully
      // emitted (time.end set). Avoids streaming partial fragments and keeps
      // /stats response_len aligned across drivers.
      const eventSid = props.sessionID || props.info?.sessionID || part.sessionID
      if (
        part.type === 'text' &&
        part.text &&
        part.time?.end &&
        eventSid === sessionID
      ) {
        return { text: part.text, partId: part.id }
      }
    }

    return {}
  }

  /**
   * `session.status` event with status.type === 'idle' for our session is
   * the canonical "stop" signal in opencode (cf. run.ts:532).
   */
  isIdleEvent(event: OpencodeEvent, sessionID: string): boolean {
    if (event.type !== 'session.status') return false
    const props = event.properties ?? {}
    const sid = props.sessionID || props.info?.sessionID
    if (sid !== sessionID) return false
    return props.status?.type === 'idle' || props.info?.status?.type === 'idle'
  }

  isErrorEvent(event: OpencodeEvent, sessionID: string): { error: string } | null {
    if (event.type !== 'session.error') return null
    const props = event.properties ?? {}
    if (props.sessionID !== sessionID) return null
    const e = props.error as Record<string, unknown> | undefined
    let msg = 'session error'
    if (e && typeof e === 'object') {
      if (typeof e.name === 'string') msg = e.name
      const data = e.data as Record<string, unknown> | undefined
      if (data && typeof data.message === 'string') msg = data.message
    }
    return { error: msg }
  }

  buildHttpContextualPrompt(prompt: string, history?: ChatMessage[]): string {
    if (!history || history.length === 0) return prompt
    const historyText = history
      .map(msg => `[${msg.role === 'user' ? 'User' : 'Assistant'}]: ${msg.content}`)
      .join('\n\n')
    return `Previous conversation context:\n${historyText}\n\nCurrent request: ${prompt}`
  }

  override async *sendPrompt(
    _sessionId: string,
    prompt: string,
    history?: ChatMessage[],
    opts?: AgentSendOpts,
  ): AsyncGenerator<string> {
    const callOpts = opts ?? {}
    await this.ensureMcp()
    const baseUrl = await this.serve.ensureRunning()

    let sessionID = callOpts.agentSessionId
    if (!sessionID) {
      sessionID = await this.createSession(baseUrl, callOpts)
      if (callOpts.onAgentSessionId) {
        try { callOpts.onAgentSessionId(sessionID) } catch { /* ignore */ }
      }
      // Newly-created sessions already received the ruleset in createSession's
      // POST body — no need to PATCH again. Mark applied so we skip the dup.
      this.rulesetApplied.add(sessionID)
    } else if (callOpts.planMode) {
      // Plan mode: opencode's `plan` primary agent already ships with its own
      // stricter ruleset (edit denied except .opencode/plans/*.md). Stacking
      // the medium-gate edit/write/patch=ask rules on top would just create
      // redundant ask prompts during read-only planning. Skip the PATCH and
      // let plan agent's defaults govern this turn. We intentionally do NOT
      // mark rulesetApplied — once the user /plan off's and we resume normal
      // turns, the next non-plan turn should re-apply the medium gate.
    } else if (!this.rulesetApplied.has(sessionID)) {
      // Resumed session: opencode loaded its previously-stored ruleset,
      // which may predate the current gate policy (older sessions were
      // created with no override at all). PATCH the gate ruleset onto it
      // so edit/write/patch correctly route through the IM bridge for the
      // rest of this process's lifetime.
      //
      // Claim the slot synchronously so concurrent prompts on the same
      // session don't fire duplicate PATCHes; remove on failure so the
      // next turn retries instead of leaving the session permanently
      // unguarded if this attempt fails transiently.
      const targetSession = sessionID
      this.rulesetApplied.add(targetSession)
      this.applyRuleset(baseUrl, targetSession).catch((err: unknown) => {
        this.rulesetApplied.delete(targetSession)
        log.warn({ event: 'opencode.http.apply_ruleset_failed', err: String(err), sessionID: targetSession })
      })
    }

    log.info(
      { event: 'opencode.http.send', sessionID, historyLen: history?.length || 0, hasResume: !!callOpts.agentSessionResume },
      'sendPrompt',
    )

    // When resuming, opencode already has the conversation in its DB — feeding
    // history again would duplicate every prior turn. (Same invariant as the
    // stdio driver — see router.callAgentWithHistory zeroing effectiveHistory.)
    const contextualPrompt = callOpts.agentSessionResume
      ? prompt
      : this.buildHttpContextualPrompt(prompt, history)

    // HTTP mode quirk: the agim MCP server is shared across all opencode
    // sessions because `opencode serve` is one daemon. The MCP server's
    // env was set ONCE at daemon startup, so the runId there is stale for
    // any given turn. Workaround: ask the agent to pass `_im_context` in
    // every agim-tool call; the bus accepts it as a runId fallback. This
    // is a single-user-only path (agent could lie in multi-tenant) — see
    // approval-bus.ts:handleReminder for the trust note.
    const imCtxInstruction = buildImContextInstruction(callOpts)
    const finalPrompt = imCtxInstruction
      ? `${imCtxInstruction}\n\n${contextualPrompt}`
      : contextualPrompt

    // Subscribe BEFORE posting so we don't miss early events.
    //
    // SSE-broken fallback (opencode 1.14.45+ with node-http-server runtime):
    //   the /event stream only emits the initial server.connected and never
    //   broadcasts bus events. The POST /session/:id/message endpoint blocks
    //   until the message is complete and returns the full assistant body in
    //   JSON, so we use that as the authoritative text source. We still keep
    //   the SSE loop for older opencode versions that DO stream — yielded
    //   text-part ids are tracked so we don't emit them twice when draining
    //   the POST body. Once POST settles we schedule a brief grace then close
    //   SSE, which exits the for-await loop on the broken-stream case.
    //
    // Permission-poller (also SSE-broken fallback): permission.asked events
    // ride the same dead bus channel, so without this poller routeAsk is
    // never called and edit/write/patch hang until opencode's body timeout
    // fires. See startPermissionPoller for the contract.
    const sse = await this.openEventStream(baseUrl)
    const stopPoller = this.startPermissionPoller(baseUrl, sessionID, callOpts)
    const promptPromise = this.postPrompt(baseUrl, sessionID, finalPrompt, callOpts)
      .catch((err: unknown) => ({ error: err instanceof Error ? err : new Error(String(err)) } as const))

    // 500ms after POST resolves, force-close SSE so the for-await exits even
    // when the daemon never emits session.idle. Short enough that latency
    // stays low; long enough to flush any final events that did stream.
    //
    // The permission poller MUST also live until promptPromise settles —
    // not until for-await exits — because opencode 1.14.46's SSE closes
    // immediately after server.connected, which would end for-await within
    // milliseconds while POST is still blocked waiting for tool-permission
    // reply. Stopping the poller in the for-await finally would orphan
    // the permission with no one polling.
    promptPromise.finally(() => {
      stopPoller()
      const t = setTimeout(() => { sse.close() }, 500)
      // Don't keep the event loop alive solely for the grace-close timer.
      ;(t as unknown as { unref?: () => void }).unref?.()
    })

    const idleTimeout = resolveIdleTimeout()
    let watchdogTimedOut = false
    // Idle watchdog: re-armed on every SSE event. Without this, an SSE that
    // truly hangs (no events at all) would block the for-await forever — the
    // old in-loop `Date.now() > timeoutAt` only fired when an event arrived.
    let watchdog: ReturnType<typeof setTimeout> | null = null
    const armWatchdog = (): void => {
      if (idleTimeout <= 0) return
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => {
        watchdogTimedOut = true
        sse.close()  // unblocks the for-await
      }, idleTimeout)
    }
    armWatchdog()

    let surfacedError: string | null = null
    const yieldedPartIds = new Set<string>()
    let sseYieldedAnyText = false

    try {
      for await (const event of sse) {
        armWatchdog()

        if (event.type === 'permission.asked') {
          this.routeAsk(event, baseUrl, sessionID, callOpts)
          continue
        }

        const errEvent = this.isErrorEvent(event, sessionID)
        if (errEvent) {
          surfacedError = errEvent.error
          continue
        }

        const { text, partId } = this.inspectHttpEvent(event, sessionID, callOpts)
        if (text) {
          if (partId) yieldedPartIds.add(partId)
          sseYieldedAnyText = true
          yield text
        }

        if (this.isIdleEvent(event, sessionID)) {
          break
        }
      }
    } finally {
      if (watchdog) clearTimeout(watchdog)
      // stopPoller is intentionally NOT called here — see the comment on
      // promptPromise.finally above for the lifecycle rationale.
      sse.close()
    }

    if (watchdogTimedOut) {
      const mins = Math.round(idleTimeout / 60000)
      log.warn(
        { event: 'opencode.http.idle-timeout', sessionID, idleTimeoutMs: idleTimeout, reason: 'idle' },
        `opencode HTTP idle for ${mins}min — assumed hang, terminated`)
      yield `\n\n⚠️ opencode 子进程 ${mins} 分钟无任何输出，强制超时（可能 hang 或网络挂起）`
      return
    }

    const result = await promptPromise
    if (result && typeof result === 'object' && 'error' in result) {
      // undici wraps the real socket-level error on .cause; the bare
      // .message is just "fetch failed". Log both so an operator can tell
      // a 5-min bodyTimeout (UND_ERR_BODY_TIMEOUT) apart from ECONNRESET,
      // ETIMEDOUT, ECONNREFUSED, etc.
      const e = result.error as Error & { cause?: { code?: string; message?: string; name?: string } }
      const cause = e.cause
      log.warn(
        {
          event: 'opencode.http.prompt_failed',
          err: String(e),
          causeName: cause?.name,
          causeCode: cause?.code,
          causeMessage: cause?.message,
        },
        'prompt POST failed',
      )
      yield `opencode failed: ${e.message}${cause?.code ? ` (${cause.code})` : ''}`
      return
    }

    // SSE-broken fallback: drain text + usage from the POST response body.
    // No-op when SSE already streamed everything (yieldedPartIds covers it).
    if (result && typeof result === 'object' && !('error' in result)) {
      const drained = this.drainResponseBody(result, yieldedPartIds, callOpts)
      if (drained.length > 0) {
        if (!sseYieldedAnyText) {
          log.info(
            { event: 'opencode.http.drained_post_body', sessionID, parts: drained.length },
            'SSE yielded no text; recovered assistant message from POST body',
          )
        }
        for (const text of drained) yield text
      }
    }

    if (surfacedError) {
      yield `opencode session error: ${surfacedError}`
    }
  }

  /**
   * Extract assistant text + usage from the POST /session/:id/message response
   * body, skipping any text part already emitted via SSE (matched by part id).
   * Used as a fallback for opencode builds whose /event stream is broken.
   */
  drainResponseBody(
    body: OpencodeMessageResponse,
    alreadyYielded: Set<string>,
    opts: AgentSendOpts,
  ): string[] {
    const parts = Array.isArray(body.parts) ? body.parts : []

    if (opts.onUsage && body.info) {
      const delta: { costUsd?: number; tokensInput?: number; tokensOutput?: number } = {}
      if (typeof body.info.cost === 'number' && Number.isFinite(body.info.cost)) {
        delta.costUsd = body.info.cost
      }
      if (typeof body.info.tokens?.input === 'number') delta.tokensInput = body.info.tokens.input
      if (typeof body.info.tokens?.output === 'number') delta.tokensOutput = body.info.tokens.output
      if (delta.costUsd !== undefined || delta.tokensInput !== undefined || delta.tokensOutput !== undefined) {
        try { opts.onUsage(delta) } catch { /* ignore */ }
      }
    }

    const texts: string[] = []
    for (const part of parts) {
      if (part.type !== 'text') continue
      if (typeof part.text !== 'string' || part.text.length === 0) continue
      if (!part.time?.end) continue
      if (part.id && alreadyYielded.has(part.id)) continue
      texts.push(part.text)
    }
    return texts
  }

  // ─── permission bridge ────────────────────────────────────────────────

  /**
   * Decide how to handle a `permission.asked` SSE event:
   *   - If `this.approvalBus` is set AND has a notifier installed AND the
   *     call carries enough IM context (threadId + platform) → register a
   *     synthetic pending so the user gets an IM card; the bus's resolve
   *     callback POSTs the decision back to opencode via /permission/.../reply.
   *   - Otherwise → fall back to `once`. Without an IM channel there's no
   *     human to ask, and a plain `reject` would surface as a tool-call
   *     failure mid-conversation which is worse UX than allowing.
   *
   * Fire-and-forget: the SSE loop must keep draining other events while the
   * bridge waits for the user. The bus enforces its own timeout (5 min by
   * default) so we never deadlock the SSE loop.
   */
  private routeAsk(event: OpencodeEvent, baseUrl: string, ocSessionID: string, opts: AgentSendOpts): void {
    const props = event.properties ?? {}
    const reqId = props.id
    if (typeof reqId !== 'string') return

    const fallback = (): void => {
      this.replyPermission(baseUrl, reqId, 'once').catch((err: unknown) => {
        log.warn({ event: 'opencode.http.ask_fallback_failed', err: String(err), reqId })
      })
    }

    const bus = this.approvalBus
    const canBridge = bus?.hasNotifier()
      && typeof opts.threadId === 'string' && opts.threadId.length > 0
      && typeof opts.platform === 'string' && opts.platform.length > 0

    if (!canBridge) {
      fallback()
      return
    }

    const ctx = {
      threadId: opts.threadId as string,
      platform: opts.platform as string,
      userId: opts.userId ?? '',
      channelId: opts.channelId ?? '',
    }
    const dispatch = (decision: Decision): void => {
      const wire = decisionToOpencodeReply(decision)
      this.replyPermission(baseUrl, reqId, wire.reply, wire.message).catch((err: unknown) => {
        log.warn({ event: 'opencode.http.ask_reply_failed', err: String(err), reqId })
      })
    }

    bus?.registerSyntheticPending({
      runId: ocSessionID,  // opencode session id IS the run id from the bus's POV
      reqId,
      toolName: typeof props.permission === 'string' ? props.permission : 'permission',
      input: {
        ...(Array.isArray(props.patterns) ? { patterns: props.patterns } : {}),
        ...(props.metadata && typeof props.metadata === 'object' ? props.metadata : {}),
      },
      ctx,
      dispatch,
    }).catch((err: unknown) => {
      // Bus rejected (e.g. notifier removed mid-flight). Safety: fall back.
      log.warn({ event: 'opencode.http.bridge_register_failed', err: String(err), reqId })
      fallback()
    })
  }

  /**
   * Build the session-level permission ruleset to append to opencode's
   * agent defaults. See createSession's docstring for policy rationale.
   *
   * The returned rules are flat `{permission, pattern, action}` objects
   * matching opencode's `Permission.Rule` schema.
   */
  private buildSessionRuleset(): Array<{ permission: string; pattern: string; action: 'allow' | 'deny' | 'ask' }> {
    const gate = (process.env.AGIM_OPENCODE_GATE || 'medium').toLowerCase()
    const ask = (permission: string) => ({ permission, pattern: '*', action: 'ask' as const })
    if (gate === 'none') return []
    if (gate === 'strict') return [ask('edit'), ask('write'), ask('patch'), ask('bash')]
    if (gate === 'loose') return [ask('edit'), ask('write')]
    return [ask('edit'), ask('write'), ask('patch')]  // medium (default)
  }

  /**
   * PATCH a resumed session with our gate ruleset so subsequent tool calls
   * surface as `permission.asked` events for the bridge. opencode's update
   * endpoint merges (current + payload) — payload comes last and wins under
   * findLast semantics. Idempotent across agim restarts but NOT within a
   * single process: the caller (sendPrompt) gates on rulesetApplied.
   */
  private async applyRuleset(baseUrl: string, sessionID: string): Promise<void> {
    const ruleset = this.buildSessionRuleset()
    if (ruleset.length === 0) return  // gate=none
    const res = await this.fetchImpl(`${baseUrl}/session/${sessionID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permission: ruleset }),
    })
    if (!res.ok) {
      throw new Error(`opencode session update failed: HTTP ${res.status}`)
    }
    await res.text().catch(() => '')
    log.info({ event: 'opencode.http.ruleset_applied', sessionID, gate: process.env.AGIM_OPENCODE_GATE || 'medium' },
      'applied gate ruleset to resumed session')
  }

  // ─── HTTP plumbing ──────────────────────────────────────────────────────

  private async createSession(baseUrl: string, opts: AgentSendOpts): Promise<string> {
    // Session-level permission overrides for IM-launched runs.
    //
    // Why we override at all:
    //   opencode's built-in `build` agent ships with a `*: allow` catch-all
    //   (agent.ts:86-103 in the upstream repo). With findLast semantics,
    //   that swallows mutating tools like edit/write/patch unless we
    //   *append* stricter rules whose specificity wins.
    //
    // The "medium" policy (default):
    //   - edit / write / patch → ask: any time the assistant wants to
    //     mutate files, surface an IM card. These are the operations a
    //     user wants to "拍板".
    //   - bash is intentionally NOT gated: IM-driven exploration involves
    //     a flood of `ls` / `cat` / `git status` and asking on every one
    //     would drown the user. Mutations the LLM does via bash (rm,
    //     npm install, git commit) aren't caught here — that's a known
    //     gap; revisit if it bites in practice.
    //   - external_directory is already `ask` by default for paths
    //     outside the cwd / skill whitelist; we don't need to repeat it
    //     and it would be surprising to override.
    //
    // Override path: env AGIM_OPENCODE_GATE=strict|loose|none flips this
    // policy without redeploy:
    //   strict → bash also asks
    //   loose  → only write+edit (drop patch)
    //   none   → no override (mostly for debugging)
    const body: Record<string, unknown> = {
      title: 'agim session',
    }
    // Plan mode: route through opencode's built-in `plan` agent and skip our
    // medium-gate ruleset entirely (plan agent's edit-deny-except-plans
    // policy is already stricter than the IM gate would impose).
    if (opts.planMode) {
      body.agent = 'plan'
    } else {
      body.permission = this.buildSessionRuleset()
    }
    const res = await this.fetchImpl(`${baseUrl}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`opencode session create failed: HTTP ${res.status} ${await safeText(res)}`)
    }
    const json = await res.json() as { id?: string }
    if (!json.id) throw new Error('opencode session create returned no id')
    log.info(
      {
        event: 'opencode.http.session_created',
        sessionID: json.id,
        cwd: resolveAgentCwd('opencode', opts),
      },
      'session created',
    )
    return json.id
  }

  private async postPrompt(
    baseUrl: string,
    sessionID: string,
    prompt: string,
    opts: AgentSendOpts,
  ): Promise<OpencodeMessageResponse> {
    const body: Record<string, unknown> = {
      parts: [{ type: 'text', text: prompt }],
    }
    if (opts.model) body.model = opts.model
    if (opts.variant) body.variant = opts.variant
    // planMode forces the plan agent on every turn, including resumed sessions
    // that were originally created under build. opencode's per-message `agent`
    // field overrides the session's default agent for this single turn.
    if (opts.planMode) body.agent = 'plan'
    // `dispatcher` is an undici-only fetch option (Node's fetch IS undici).
    // See the `longRunningDispatcher` comment at the top of this file for
    // why we disable the underlying socket timeouts here.
    const res = await this.fetchImpl(`${baseUrl}/session/${sessionID}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      dispatcher: longRunningDispatcher,
    })
    if (!res.ok) {
      throw new Error(`opencode prompt failed: HTTP ${res.status} ${await safeText(res)}`)
    }
    // On opencode 1.14.45+ the POST blocks until the assistant message is
    // complete and returns the full body. We parse it (best-effort) so the
    // caller can recover text + usage when /event SSE doesn't broadcast.
    try {
      return await res.json() as OpencodeMessageResponse
    } catch {
      return {}
    }
  }

  /**
   * Poll `GET /permission` as the fallback channel for permission.asked when
   * opencode's SSE bus is broken (1.14.45+). Every tick lists pending
   * permissions for the daemon, filters to this session, and feeds new
   * entries through routeAsk — the same bridge the SSE path would have used.
   *
   * Local `seen` Set keeps a turn from re-routing the same reqId on every
   * tick. The bus also dedupes by reqId in registerSyntheticPending, so a
   * future opencode build that fixes SSE won't cause double-routing.
   *
   * The first tick fires immediately so a permission already pending at
   * sendPrompt entry (e.g. one persisted from a previous opencode serve
   * lifetime) surfaces without waiting an interval.
   *
   * Returns a stop function. Caller MUST invoke it in finally{} to prevent
   * the interval from leaking once the turn ends.
   */
  private startPermissionPoller(
    baseUrl: string,
    sessionID: string,
    opts: AgentSendOpts,
  ): () => void {
    const seen = new Set<string>()
    let stopped = false

    const tick = async (): Promise<void> => {
      if (stopped) return
      try {
        const res = await this.fetchImpl(`${baseUrl}/permission`)
        if (!res.ok) return
        const list = await res.json() as Array<{
          id?: unknown
          sessionID?: unknown
          permission?: unknown
          patterns?: unknown
          metadata?: unknown
        }>
        if (!Array.isArray(list)) return
        for (const item of list) {
          if (typeof item.id !== 'string') continue
          if (item.sessionID !== sessionID) continue
          if (seen.has(item.id)) continue
          seen.add(item.id)
          const event: OpencodeEvent = {
            type: 'permission.asked',
            properties: {
              id: item.id,
              permission: typeof item.permission === 'string' ? item.permission : undefined,
              patterns: Array.isArray(item.patterns) ? item.patterns as string[] : undefined,
              metadata: (item.metadata && typeof item.metadata === 'object')
                ? item.metadata as Record<string, unknown>
                : undefined,
            },
          }
          log.info(
            { event: 'opencode.http.poll_routed', sessionID, reqId: item.id, permission: event.properties?.permission },
            'pending permission surfaced via REST poll (SSE broken)',
          )
          this.routeAsk(event, baseUrl, sessionID, opts)
        }
      } catch (err) {
        log.warn({
          event: 'opencode.http.poll_pending_failed',
          err: String(err),
          sessionID,
        })
      }
    }

    const interval = setInterval(() => { void tick() }, 1500)
    void tick()

    return () => {
      stopped = true
      clearInterval(interval)
    }
  }

  private async replyPermission(
    baseUrl: string,
    requestId: string,
    reply: 'once' | 'always' | 'reject',
    message?: string,
  ): Promise<void> {
    const body: Record<string, unknown> = { reply }
    if (reply === 'reject' && message) body.message = message
    const res = await this.fetchImpl(`${baseUrl}/permission/${requestId}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      throw new Error(`opencode permission reply HTTP ${res.status}`)
    }
  }

  private async openEventStream(baseUrl: string): Promise<EventStream> {
    const res = await this.fetchImpl(`${baseUrl}/event`, {
      headers: { Accept: 'text/event-stream' },
    })
    if (!res.ok || !res.body) {
      throw new Error(`opencode event stream failed: HTTP ${res.status}`)
    }
    return new EventStream(res.body)
  }
}

/**
 * Map a bus Decision to opencode's permission.reply schema.
 *
 * Mapping rules:
 *   - allow            → once   (one-shot grant; matches what TUI sends)
 *   - allow + autoAllowFurther → once on the wire; the bus has already
 *     registered an im-side auto-allow rule by side effect (see
 *     ApprovalBus.cancelPending). We deliberately do NOT promote to
 *     opencode's `always` because that would persist a ruleset addition on
 *     the opencode session, which is heavier scope than the IM rule.
 *   - deny + message   → reject (+ message). opencode surfaces this as a
 *     CorrectedError ("user rejected … with feedback"), giving the LLM a
 *     useful hint instead of a bare reject.
 *   - deny             → reject
 */
/**
 * Compose the system instruction telling the agent how to identify the
 * IM thread when it calls agim MCP tools. Empty string when we don't
 * have full IM context (web/scheduler/intent-llm calls) — those won't
 * have reminder tools wired anyway.
 *
 * Single-user trust model: this prompt asks the agent to assert the
 * caller's identity. A malicious or confused agent could pass another
 * user's IDs. Acceptable for personal deployments; multi-tenant operators
 * should use claude-code (per-spawn env via --mcp-config) or opencode
 * stdio (per-spawn extraEnv) instead.
 */
function buildImContextInstruction(opts: AgentSendOpts): string {
  const platform = opts.platform
  const threadId = opts.threadId
  const channelId = opts.channelId
  if (!platform || !threadId || !channelId) return ''
  const userId = opts.userId ?? ''
  const ctx = JSON.stringify({ platform, threadId, channelId, userId })
  return [
    '[agim MCP routing — important]',
    'When you call any agim tool — reminder family (create_reminder /',
    'list_reminders / cancel_reminder / snooze_reminder) or memo family',
    '(save_memo / search_memos / update_memo / delete_memo /',
    'request_location_capture) — you MUST include this exact `_im_context`',
    'field in the tool input so the call routes to the correct IM thread:',
    '',
    `  "_im_context": ${ctx}`,
    '',
    'Pass these values verbatim — do not invent or modify them.',
    '',
    '[memo timezone] All times in memo tools are Asia/Shanghai (UTC+8).',
    'When the user says relative dates ("明天" / "下周三" / "下午3点"),',
    'compute the absolute datetime in UTC+8 and emit "YYYY-MM-DD HH:MM:SS"',
    '(no T, no offset suffix). The server normalizes if you slip an offset',
    'in, but emit local directly to keep the chat consistent.',
  ].join('\n')
}

function decisionToOpencodeReply(decision: Decision): { reply: 'once' | 'always' | 'reject'; message?: string } {
  if (decision.behavior === 'allow') return { reply: 'once' }
  return decision.message
    ? { reply: 'reject', message: decision.message }
    : { reply: 'reject' }
}

function resolveIdleTimeout(): number {
  const sources: Array<[string, string | undefined]> = [
    ['OPENCODE_IDLE_TIMEOUT_MS', process.env.OPENCODE_IDLE_TIMEOUT_MS],
    ['AGIM_AGENT_IDLE_TIMEOUT_MS', process.env.AGIM_AGENT_IDLE_TIMEOUT_MS],
  ]
  for (const [envKey, raw] of sources) {
    if (raw === undefined) continue
    const n = parseInt(raw, 10)
    if (Number.isFinite(n) && n >= 0) return n
    log.warn({ event: 'opencode.http.idle-timeout.invalid', raw, envKey },
      `Invalid idle timeout env "${envKey}=${raw}", trying next source / default`)
  }
  return DEFAULT_IDLE_TIMEOUT_MS
}

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 500) } catch { return '' }
}

/**
 * Minimal SSE parser. opencode's /event endpoint emits `data: <JSON>\n\n`
 * frames; we ignore other SSE fields (`event:`, `id:`, `retry:`) — opencode
 * doesn't use them. close() releases the underlying reader so the server's
 * heartbeat path detects the disconnect.
 *
 * The reader's exact static type clashes between Node's `stream/web` and
 * DOM's `ReadableStreamDefaultReader` (the latter has the extra `readMany`
 * member). At runtime fetch() returns whatever the host provides; we only
 * need read() / cancel() — declared locally so TS picks the narrow shape.
 */
interface MinimalReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>
  cancel(): Promise<void>
}

export class EventStream implements AsyncIterable<OpencodeEvent> {
  private reader: MinimalReader
  private decoder = new TextDecoder('utf-8')
  private buf = ''
  private closed = false

  constructor(body: NonNullable<Response['body']>) {
    this.reader = body.getReader() as unknown as MinimalReader
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try { void this.reader.cancel() } catch { /* ignore */ }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<OpencodeEvent> {
    while (!this.closed) {
      const { value, done } = await this.reader.read()
      if (done) return
      if (!value) continue
      this.buf += this.decoder.decode(value, { stream: true })
      while (true) {
        const idx = this.buf.indexOf('\n\n')
        if (idx === -1) break
        const frame = this.buf.slice(0, idx)
        this.buf = this.buf.slice(idx + 2)
        const evt = parseSseFrame(frame)
        if (evt) yield evt
      }
    }
  }
}

function parseSseFrame(frame: string): OpencodeEvent | null {
  let payload = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('data:')) {
      payload += line.slice(5).trimStart()
    }
  }
  if (!payload) return null
  try {
    return JSON.parse(payload) as OpencodeEvent
  } catch {
    return null
  }
}

export type { OpencodeEvent }
