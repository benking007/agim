export type BuiltInAgentKind = 'cli' | 'in-process'
export type BuiltInAgentScope = 'bridged' | 'agim'

export interface BuiltInAgentSurface {
  id: string
  displayName: string
  aliases: string[]
  configAliases: string[]
  kind: BuiltInAgentKind
  scope: BuiltInAgentScope
  configSection: 'agents' | 'agim'
  readinessPriority: number
  install: {
    command: string
    probeArgs: string[]
    npmPackage?: string
    installCommand?: string
    requiresAuthHint: boolean
  }
}

export interface AgentCatalogResponse {
  agents: BuiltInAgentSurface[]
}
