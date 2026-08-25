import { QueryClient } from '@tanstack/react-query'

import { settingsKeys } from '@/hooks/use-settings'
import type { AppConfig } from '@/types/api'

const TEST_WORKBENCH_CONFIG: AppConfig = {
  messengers: [],
  agents: ['agim'],
  defaultAgent: 'agim',
}

/**
 * Route tests that render WorkbenchFrame also mount its footer config
 * query and, for members, the agents-status query. Seed both so a
 * route's first mocked fetch belongs to the page under test.
 */
export function createWorkbenchQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      mutations: { retry: false },
    },
  })
  client.setQueryData(settingsKeys.config, TEST_WORKBENCH_CONFIG)
  client.setQueryData(['agents', 'status'], { agim: true })
  return client
}
