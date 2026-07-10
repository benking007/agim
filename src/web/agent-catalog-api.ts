import type { ServerResponse } from 'node:http'

import { getBuiltInAgentSurfaces } from '../core/agent-catalog.js'

/** Read-only metadata consumed by the Web agent settings page. */
export function handleAgentCatalog(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ agents: getBuiltInAgentSurfaces() }))
}
