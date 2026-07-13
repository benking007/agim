// Boot-time naming migrations (registry id, tenants field, session dir, …).
// Idempotent via flags on config.json and filesystem checks.
//
// Operator-facing guide: docs/migration-naming-v2.md

import { existsSync, renameSync, mkdirSync, chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Config } from './types.js'
import { AGIM_HOME, AGIM_WORKSPACES } from './agim-paths.js'
import { migrateNativeAgentToggle } from './config-migrate.js'

/** Canonical Agim Agent registry id (was `native`). */
export const AGIM_AGENT_ID = 'agim'
/** Legacy registry id kept as a routing alias. */
export const LEGACY_NATIVE_AGENT_ID = 'native'

export function normalizeAgentId(name: string | undefined | null): string {
  if (!name) return name ?? ''
  if (name === LEGACY_NATIVE_AGENT_ID) return AGIM_AGENT_ID
  return name
}

export function isAgimAgentId(name: string | undefined | null): boolean {
  return name === AGIM_AGENT_ID || name === LEGACY_NATIVE_AGENT_ID
}

function mapAgentList(list: string[]): { list: string[]; changed: boolean } {
  let changed = false
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const id = normalizeAgentId(raw)
    if (id !== raw) changed = true
    if (seen.has(id)) {
      changed = true
      continue
    }
    seen.add(id)
    out.push(id)
  }
  return { list: out, changed }
}

/**
 * Rewrite config agent ids `native` → `agim` (defaultAgent, agents[],
 * tenants/workspaces agent whitelists). Idempotent via `agimAgentIdMigrated`.
 */
export function migrateAgentIdNativeToAgim(config: Config): {
  config: Config
  changed: boolean
} {
  if (config.agimAgentIdMigrated === true) {
    // Still normalize in-memory if someone hand-edited after the flag.
    return normalizeConfigAgentIds(config)
  }

  const { config: normalized, changed } = normalizeConfigAgentIds({
    ...config,
    agimAgentIdMigrated: true,
  })
  return { config: normalized, changed: true || changed }
}

function normalizeConfigAgentIds(config: Config): { config: Config; changed: boolean } {
  let changed = false
  const next: Config = { ...config }

  if (typeof next.defaultAgent === 'string') {
    const d = normalizeAgentId(next.defaultAgent)
    if (d !== next.defaultAgent) {
      next.defaultAgent = d
      changed = true
    }
  }

  if (Array.isArray(next.agents)) {
    const mapped = mapAgentList(next.agents)
    if (mapped.changed) {
      next.agents = mapped.list
      changed = true
    }
  }

  const tenantKey = Array.isArray(next.tenants) ? 'tenants'
    : Array.isArray(next.workspaces) ? 'workspaces'
      : null
  if (tenantKey) {
    const rows = next[tenantKey] as Array<Record<string, unknown>>
    const mappedRows = rows.map((row) => {
      if (!row || typeof row !== 'object') return row
      if (!Array.isArray(row.agents)) return row
      const mapped = mapAgentList(row.agents as string[])
      if (!mapped.changed) return row
      changed = true
      return { ...row, agents: mapped.list }
    })
    next[tenantKey] = mappedRows
  }

  return { config: next, changed }
}

/**
 * Promote `config.workspaces` → `config.tenants` (keep workspaces as a
 * read-alias until operators save again). Flag: `tenantsFieldMigrated`.
 */
export function migrateWorkspacesToTenants(config: Config): {
  config: Config
  changed: boolean
} {
  if (config.tenantsFieldMigrated === true) {
    return { config, changed: false }
  }

  const next: Config = { ...config, tenantsFieldMigrated: true }
  let changed = true

  const hasTenants = Array.isArray(next.tenants) && (next.tenants as unknown[]).length >= 0
    && next.tenants !== undefined
  const hasWorkspaces = Array.isArray(next.workspaces)

  if (!Array.isArray(next.tenants) && hasWorkspaces) {
    next.tenants = structuredClone(next.workspaces)
    // Keep workspaces for one release so older tools still see it; writers
    // should prefer tenants going forward.
    changed = true
  } else if (hasTenants && !hasWorkspaces) {
    // already on tenants only
  }

  return { config: next, changed }
}

/** Read tenant rows from config (tenants preferred, workspaces fallback). */
export function getTenantsFromConfig(config: Config | Record<string, unknown>): Array<Record<string, unknown>> {
  const tenants = config.tenants
  if (Array.isArray(tenants)) return tenants as Array<Record<string, unknown>>
  const workspaces = config.workspaces
  if (Array.isArray(workspaces)) return workspaces as Array<Record<string, unknown>>
  return []
}

/**
 * Rename `~/.agim/pi-sessions` → `~/.agim/agim-sessions` when needed.
 * Returns the canonical sessions root path.
 */
export function migratePiSessionsDir(home: string = AGIM_HOME): string {
  const legacy = join(home, 'pi-sessions')
  const target = join(home, 'agim-sessions')
  try {
    if (existsSync(legacy) && !existsSync(target)) {
      renameSync(legacy, target)
    } else if (!existsSync(target)) {
      mkdirSync(target, { recursive: true, mode: 0o700 })
    }
    try { chmodSync(target, 0o700) } catch { /* non-POSIX */ }
  } catch (err) {
    // Fall back to whichever exists so boot is not blocked.
    console.error(
      '[agim] failed to migrate pi-sessions → agim-sessions:',
      err instanceof Error ? err.message : err,
    )
    if (existsSync(legacy)) return legacy
    try { mkdirSync(target, { recursive: true, mode: 0o700 }) } catch { /* ignore */ }
  }
  return existsSync(target) ? target : (existsSync(legacy) ? legacy : target)
}

/**
 * Best-effort rewrite of session meta `agent: "native"` → `"agim"`.
 * Skips corrupt files; never throws.
 */
export function migrateSessionAgentIds(home: string = AGIM_HOME): number {
  const dir = join(home, 'sessions')
  if (!existsSync(dir)) return 0
  let n = 0
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return 0 }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    try {
      const raw = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (parsed.agent !== LEGACY_NATIVE_AGENT_ID) continue
      parsed.agent = AGIM_AGENT_ID
      writeFileSync(path, JSON.stringify(parsed, null, 2), { mode: 0o600 })
      n += 1
    } catch { /* skip */ }
  }
  return n
}

/**
 * Rename `~/.agim-workspaces/native` → `…/agim` when the target is absent.
 */
export function migrateAgentWorkspaceDir(): void {
  try {
    const legacy = join(AGIM_WORKSPACES, LEGACY_NATIVE_AGENT_ID)
    const target = join(AGIM_WORKSPACES, AGIM_AGENT_ID)
    if (existsSync(legacy) && !existsSync(target)) {
      renameSync(legacy, target)
    }
  } catch { /* best-effort */ }
}

/**
 * Run all config-level naming migrations in order. Returns the updated
 * config and whether anything changed (caller should persist).
 */
export function migrateNamingV2(config: Config): { config: Config; changed: boolean } {
  let changed = false
  let current = config

  // 1) Ensure legacy installs still have Agim Agent in agents[] (old native toggle).
  {
    const step = migrateNativeAgentToggle(current)
    current = step.config
    if (step.changed) changed = true
  }

  // 2) native → agim registry id in config fields.
  {
    const step = migrateAgentIdNativeToAgim(current)
    current = step.config
    if (step.changed) changed = true
  }

  // After id migration, if agents listed legacy-only native that became agim,
  // migrateNativeAgentToggle may have added native — normalize again.
  {
    const step = normalizeConfigAgentIds(current)
    current = step.config
    if (step.changed) changed = true
  }

  // 3) workspaces → tenants
  {
    const step = migrateWorkspacesToTenants(current)
    current = step.config
    if (step.changed) changed = true
  }

  return { config: current, changed }
}

/** Re-export for callers that still import the toggle migrator alone. */
export { migrateNativeAgentToggle }
