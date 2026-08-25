/**
 * lib/api/ws.ts — WebSocket client with exponential backoff + mobile-
 * aware reconnect (visibility / online / native-shell resume).
 *
 * One module-level instance per path: openChatWs() returns the same
 * connection across remounts of the chat route, so a fast navigate
 * away and back doesn't tear down + re-establish (mobile networks
 * make handshake-flapping painful).
 *
 * Wire protocol is the legacy NDJSON-over-WS shape — see types/ws.ts.
 * Auth is implicit: same-origin cookie travels with the upgrade
 * request, so the backend's loopback / token gate applies the same
 * way it does for REST.
 *
 * Mobile / native-shell reconnect strategy:
 *   * `visibilitychange` / `pageshow` / `agim-resume` → force a new
 *     handshake even when readyState still looks OPEN. iOS/macOS
 *     WKWebView suspends the TCP session in the background but often
 *     leaves readyState=OPEN (zombie). Sends then silently drop and
 *     get-history never re-runs — the chat looks "dead".
 *   * `online` → same forced handshake (skip backoff).
 *   * `offline` → leave the socket alone; the OS will close it.
 *
 * Backoff: 1s → 2s → 5s → 10s → 30s (cap), reset on first
 * successful OPEN. Each handler subscribes via `subscribe(cb)` and
 * is called with every inbound message + connection lifecycle event.
 */

import type { ChatIncoming, ChatOutgoing } from '@/types/ws'

type Listener =
  | { type: 'message'; fn: (msg: ChatIncoming) => void }
  | { type: 'status'; fn: (s: WsStatus) => void }

export type WsStatus = 'connecting' | 'open' | 'closed' | 'error'

interface ChatWsHandle {
  send: (msg: ChatOutgoing) => boolean
  subscribe: (l: Listener) => () => void
  status: () => WsStatus
  /** Tear down the current socket and handshake again (new cookie / account). */
  reconnect: () => void
  close: () => void
}

const BACKOFF_STEPS_MS = [1000, 2000, 5000, 10_000, 30_000]

/** visibility + pageshow + native `agim-resume` often fire together. */
export const WS_RESUME_DEBOUNCE_MS = 1500

/**
 * Whether a resume event (app foreground / tab visible) should tear
 * down the current socket and handshake again.
 */
export function shouldForceResumeReconnect(
  now: number,
  lastForcedAt: number,
  debounceMs = WS_RESUME_DEBOUNCE_MS,
): boolean {
  return now - lastForcedAt >= debounceMs
}

function buildWsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${path}`
}

let singleton: ChatWsHandle | null = null

export function openChatWs(): ChatWsHandle {
  if (singleton) return singleton

  let ws: WebSocket | null = null
  let status: WsStatus = 'connecting'
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let connGen = 0
  let lastForcedAt = 0
  const listeners = new Set<Listener>()

  function notifyStatus(next: WsStatus): void {
    status = next
    for (const l of listeners) if (l.type === 'status') l.fn(next)
  }

  function notifyMessage(msg: ChatIncoming): void {
    for (const l of listeners) if (l.type === 'message') l.fn(msg)
  }

  function clearReconnect(): void {
    if (reconnectTimer != null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function scheduleReconnect(): void {
    if (closed) return
    clearReconnect()
    const delay = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)] ?? 30_000
    attempt += 1
    reconnectTimer = setTimeout(() => connect(), delay)
  }

  function abandonSocket(socket: WebSocket | null): void {
    if (!socket) return
    try { socket.close() } catch { /* ignore */ }
  }

  function connect(): void {
    clearReconnect()
    const myGen = ++connGen
    lastForcedAt = Date.now()
    notifyStatus('connecting')
    const prev = ws
    ws = null
    // Close the previous socket AFTER bumping gen so its `close`
    // handler is stale and cannot schedule a competing reconnect.
    abandonSocket(prev)
    try {
      const socket = new WebSocket(buildWsUrl('/ws'))
      ws = socket
      socket.addEventListener('open', () => {
        if (myGen !== connGen) return
        attempt = 0
        notifyStatus('open')
      })
      socket.addEventListener('message', (e: MessageEvent<string>) => {
        if (myGen !== connGen) return
        let parsed: ChatIncoming
        try {
          parsed = JSON.parse(e.data) as ChatIncoming
        } catch {
          console.warn('[ws] bad json', e.data?.slice?.(0, 200))
          return
        }
        notifyMessage(parsed)
      })
      socket.addEventListener('close', () => {
        if (myGen !== connGen) return
        if (ws === socket) ws = null
        notifyStatus('closed')
        if (!closed) scheduleReconnect()
      })
      socket.addEventListener('error', () => {
        if (myGen !== connGen) return
        notifyStatus('error')
      })
    } catch (err) {
      notifyStatus('error')
      console.warn('[ws] construct failed', err)
      scheduleReconnect()
    }
  }

  function resumeReconnect(): void {
    if (closed) return
    if (!shouldForceResumeReconnect(Date.now(), lastForcedAt)) return
    attempt = 0
    connect()
  }

  function send(msg: ChatOutgoing): boolean {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  function subscribe(l: Listener): () => void {
    listeners.add(l)
    // Replay current status to a new subscriber so it doesn't have
    // to wait for the next transition.
    if (l.type === 'status') l.fn(status)
    return () => {
      listeners.delete(l)
    }
  }

  function close(): void {
    closed = true
    connGen += 1
    clearReconnect()
    abandonSocket(ws)
    ws = null
    singleton = null  // allow a future openChatWs() to start fresh
  }

  function onVisibility(): void {
    if (document.visibilityState !== 'visible') return
    resumeReconnect()
  }
  function onPageShow(): void {
    resumeReconnect()
  }
  function onAgimResume(): void {
    resumeReconnect()
  }
  function onOnline(): void {
    attempt = 0
    if (closed) return
    // Network back — handshake even if the old socket still looks OPEN.
    if (!shouldForceResumeReconnect(Date.now(), lastForcedAt) && ws?.readyState === WebSocket.OPEN) {
      return
    }
    connect()
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('agim-resume', onAgimResume)
  window.addEventListener('online', onOnline)

  connect()

  function reconnectNow(): void {
    if (closed) return
    attempt = 0
    connect()
  }

  singleton = {
    send,
    subscribe,
    status: () => status,
    reconnect: reconnectNow,
    close: () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('agim-resume', onAgimResume)
      window.removeEventListener('online', onOnline)
      close()
    },
  }
  return singleton
}

/** Handshake again so the upgrade carries the current login cookie. */
export function reconnectChatWs(): void {
  singleton?.reconnect()
}
