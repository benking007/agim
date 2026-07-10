import { client } from './client'
import type { AgentCatalogResponse } from '@/types/agent-catalog'

export function getAgentCatalog(): Promise<AgentCatalogResponse> {
  return client.get<AgentCatalogResponse>('/api/agents/catalog')
}
