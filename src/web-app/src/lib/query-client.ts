/**
 * lib/query-client.ts — single QueryClient instance for the app.
 *
 * Defaults tuned for an admin/ops console:
 *   - 30s staleTime: lists feel "live" without hammering the API
 *     every focus event; routes that need true real-time (jobs,
 *     approvals) subscribe to /events SSE on top via useEventStream
 *     (PR-9).
 *   - retry: 0 on mutations (idempotency unclear backend-side); 1
 *     retry on queries with a short backoff (transient flakes
 *     during agent boot are common).
 *   - refetchOnWindowFocus: false — the agim console isn't a
 *     dashboard people leave open in the background; tab focus
 *     refetching causes more janky reloads than useful refreshes.
 *     The SSE channel is the explicit live-data path.
 */

import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,    // mobile WiFi/cell swap → refetch
    },
    mutations: {
      retry: 0,
    },
  },
})
