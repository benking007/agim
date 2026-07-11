/**
 * useEventStream — subscribe to the backend's /events SSE channel.
 *
 * Wire-up:
 *   const status = useEventStream({
 *     job: (e) => qc.invalidateQueries({ queryKey: ['jobs'] }),
 *     approval: (e) => qc.invalidateQueries({ queryKey: ['approvals'] }),
 *   })
 *
 * Per-handler subscription so each route only listens to the events
 * it actually cares about — no point invalidating the metrics query
 * because a job started.
 *
 * Authentication:
 *   EventSource doesn't allow setting Authorization headers (the
 *   browser API only accepts a URL + withCredentials flag). The
 *   backend accepts the agim_token cookie which is set during
 *   /api/auth/login. `withCredentials: true` makes the cookie travel
 *   on the SSE request → same-origin auth works.
 *
 * Auto-reconnect:
 *   EventSource reconnects on its own when the network blips, but on
 *   iOS it pauses the stream when the tab is backgrounded and the
 *   reconnect is unreliable when the tab returns. We bind
 *   visibilitychange + window 'online' to force-reopen, matching the
 *   WS singleton's strategy.
 *
 * Connection sharing:
 *   Each useEventStream() call spins its own EventSource. Multiple
 *   routes mounted concurrently would mean N parallel SSE
 *   connections, which is fine in practice — each route's M2 surface
 *   has at most one such hook and the backend handler is multi-
 *   subscriber-safe.
 *
 * Returns: a status string the caller can render in a "Live" pill.
 */

import { useEffect, useRef, useState } from 'react'
import type {
  SseAuditEvent,
  SseApprovalEvent,
  SseEvent,
  SseHelloEvent,
  SseJobEvent,
  SseMetricsEvent,
} from '@/types/sse'

export type SseStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed'

export interface UseEventStreamHandlers {
  audit?:    (event: SseAuditEvent)    => void
  approval?: (event: SseApprovalEvent) => void
  job?:      (event: SseJobEvent)      => void
  metrics?:  (event: SseMetricsEvent)  => void
  /** Fired once per connection after the server sends its hello.
   *  Useful to call queryClient.invalidateQueries on reconnect so the
   *  UI doesn't show stale data from before the gap. */
  hello?:    (event: SseHelloEvent)    => void
}

export interface UseEventStreamOptions {
  /** Override the SSE URL — for tests / dev. Defaults to /events. */
  url?: string
  /** Disable the connection entirely. Useful when a route knows the
   *  user isn't authenticated yet — caller flips this back on after
   *  sign-in. Default true. */
  enabled?: boolean
}

export function useEventStream(
  handlers: UseEventStreamHandlers,
  options: UseEventStreamOptions = {},
): SseStatus {
  const { url = '/events', enabled = true } = options
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  const [status, setStatus] = useState<SseStatus>('connecting')

  useEffect(() => {
    if (!enabled) {
      setStatus('closed')
      return
    }
    if (typeof EventSource === 'undefined') {
      // jsdom / SSR / very old browser — silently no-op.
      setStatus('closed')
      return
    }

    let es: EventSource | null = null
    let cancelled = false

    function open(): void {
      if (cancelled) return
      setStatus((prev) => (prev === 'closed' ? 'connecting' : prev))
      const source = new EventSource(url, { withCredentials: true })
      es = source

      source.addEventListener('open', () => {
        setStatus('connected')
      })

      source.addEventListener('error', () => {
        // EventSource auto-reconnects (its readyState flips to
        // CONNECTING). Surface 'reconnecting' so the UI can show a
        // pill. If the socket is permanently dead, the next iOS
        // visibilitychange / online listener will force a re-open.
        setStatus('reconnecting')
      })

      const onTyped = <T extends SseEvent>(type: T['type'], cb?: (e: T) => void): void => {
        if (!cb) return
        source.addEventListener(type, (raw: MessageEvent) => {
          let parsed: T
          try {
            parsed = JSON.parse(raw.data) as T
          } catch {
            return
          }
          handlersRef.current[type]?.(parsed as never)
        })
      }
      onTyped<SseHelloEvent>('hello', handlersRef.current.hello)
      onTyped<SseAuditEvent>('audit', handlersRef.current.audit)
      onTyped<SseApprovalEvent>('approval', handlersRef.current.approval)
      onTyped<SseJobEvent>('job', handlersRef.current.job)
      onTyped<SseMetricsEvent>('metrics', handlersRef.current.metrics)
    }

    function close(): void {
      try { es?.close() } catch { /* ignore */ }
      es = null
    }

    function reopen(): void {
      close()
      open()
    }

    function onVisible(): void {
      if (document.visibilityState === 'visible' && (!es || es.readyState !== EventSource.OPEN)) {
        reopen()
      }
    }

    function onOnline(): void {
      reopen()
    }

    open()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', onOnline)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', onOnline)
      close()
      setStatus('closed')
    }
  }, [url, enabled])

  return status
}
