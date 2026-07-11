import { QueryClient } from '@tanstack/react-query'

import { settingsKeys } from '@/hooks/use-settings'
import type { AppConfig } from '@/types/api'

const TEST_WORKBENCH_CONFIG: AppConfig = {
  messengers: [],
  agents: ['native'],
  defaultAgent: 'native',
}

/**
 * Route tests that render WorkbenchFrame also mount its footer config query.
 * Seed that shared query so a route's first mocked fetch always belongs to
 * the route under test, rather than being consumed by shell chrome.
 */
export function createWorkbenchQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })
  client.setQueryData(settingsKeys.config, TEST_WORKBENCH_CONFIG)
  return client
}
