/**
 * lib/api/ws.ts — WebSocket client with exponential backoff + mobile-
 * aware reconnect (visibility / online events).
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
 * Mobile reconnect strategy:
 *   * `visibilitychange` → on `document.visible`, if the socket is
 *     not OPEN, close-and-reconnect. iOS suspends background WS
 *     after ~30s; we don't notice the close until the tab focuses.
 *   * `online` → if the device was offline, immediately attempt one
 *     fresh connect (skip backoff).
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
  close: () => void
}

const BACKOFF_STEPS_MS = [1000, 2000, 5000, 10_000, 30_000]

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

  function connect(): void {
    clearReconnect()
    notifyStatus('connecting')
    try {
      ws = new WebSocket(buildWsUrl('/ws'))
    } catch (err) {
      // Construction itself failed (CSP, invalid URL, etc.). Retry.
      notifyStatus('error')
      console.warn('[ws] construct failed', err)
      scheduleReconnect()
      return
    }
    ws.addEventListener('open', () => {
      attempt = 0
      notifyStatus('open')
    })
    ws.addEventListener('message', (e: MessageEvent<string>) => {
      let parsed: ChatIncoming
      try {
        parsed = JSON.parse(e.data) as ChatIncoming
      } catch {
        console.warn('[ws] bad json', e.data?.slice?.(0, 200))
        return
      }
      notifyMessage(parsed)
    })
    ws.addEventListener('close', () => {
      notifyStatus('closed')
      if (!closed) scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      // The browser will fire `close` right after; don't double-
      // schedule a reconnect here.
      notifyStatus('error')
    })
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
    clearReconnect()
    try { ws?.close() } catch { /* ignore */ }
    ws = null
    singleton = null  // allow a future openChatWs() to start fresh
  }

  // Mobile: re-handshake on visibility / online events. iOS suspends
  // background tabs' WS after ~30s and the SPA only finds out when
  // the user comes back. Forcing a reconnect on visible+closed is
  // cheap and keeps the chat stream live.
  function onVisibility(): void {
    if (document.visibilityState !== 'visible') return
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      attempt = 0
      connect()
    }
  }
  function onOnline(): void {
    attempt = 0
    if (!ws || ws.readyState !== WebSocket.OPEN) connect()
  }
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)

  connect()

  singleton = {
    send,
    subscribe,
    status: () => status,
    close: () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      close()
    },
  }
  return singleton
}
