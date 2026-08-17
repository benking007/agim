// tool-packs — optional Agim Agent tool/plugin packs toggled from Settings.
//
// Core surface (builtin / fs / exec / todo / plan-exit / mcp__agim__*) stays
// always on. Optional packs are filtered out of advertise + dispatch when
// disabled so the model cannot call them. Defaults preserve pre-pack
// behavior when `toolPacks` is absent from config.json.

import { getLiveConfig } from '../live-config.js'

export const TOOL_PACK_IDS = ['git', 'codingGate', 'web'] as const
export type ToolPackId = (typeof TOOL_PACK_IDS)[number]

export type ToolPacksConfig = Partial<Record<ToolPackId, boolean>>

/** Defaults when a key is missing but `toolPacks` object exists. */
export const TOOL_PACK_DEFAULTS: Readonly<Record<ToolPackId, boolean>> = {
  git: true,
  codingGate: false,
  web: true,
}

/**
 * When `toolPacks` is entirely absent from config, keep legacy always-on
 * so upgrades do not silently strip coding tools mid-flight.
 */
export const TOOL_PACK_LEGACY_ALL_ON: Readonly<Record<ToolPackId, boolean>> = {
  git: true,
  codingGate: true,
  web: true,
}

export interface ResolvedToolPacks {
  git: boolean
  codingGate: boolean
  web: boolean
}

export function resolveToolPacks(raw: ToolPacksConfig | null | undefined): ResolvedToolPacks {
  if (raw == null || typeof raw !== 'object') {
    return { ...TOOL_PACK_LEGACY_ALL_ON }
  }
  return {
    git: typeof raw.git === 'boolean' ? raw.git : TOOL_PACK_DEFAULTS.git,
    codingGate: typeof raw.codingGate === 'boolean' ? raw.codingGate : TOOL_PACK_DEFAULTS.codingGate,
    web: typeof raw.web === 'boolean' ? raw.web : TOOL_PACK_DEFAULTS.web,
  }
}

/** Read packs from live config (SPA toggles apply on next agent turn). */
export function resolveToolPacksFromLiveConfig(): ResolvedToolPacks {
  const cfg = getLiveConfig() as { toolPacks?: ToolPacksConfig } | null
  return resolveToolPacks(cfg?.toolPacks)
}

/** Prompt lines for enabled optional packs (empty when all off). */
export function describeEnabledToolPacks(packs: ResolvedToolPacks): string[] {
  const lines: string[] = []
  if (packs.git) {
    lines.push(
      '  - coding tools (git): agim_git_status/diff/log (read), agim_git_add/commit (approval). Prefer these over raw agim_exec for git.',
    )
  }
  if (packs.codingGate) {
    lines.push(
      '  - coding tools (gate): agim_diagnostics (Biome), agim_test_run, agim_quality_gate (lint+typecheck+test). Prefer these over raw agim_exec for verify.',
    )
  }
  if (packs.web) {
    lines.push(
      '  - native web tools: agim_web_fetch, agim_web_search. Private IPs blocked by default.',
    )
  }
  return lines
}

export function planModeReadToolsHint(packs: ResolvedToolPacks): string {
  const parts = [
    'agim_read_file',
    'agim_list_dir',
    'agim_glob',
    'agim_grep',
  ]
  if (packs.git) parts.push('agim_git_status', 'agim_git_diff')
  if (packs.codingGate) parts.push('agim_diagnostics')
  if (packs.web) parts.push('agim_web_fetch', 'agim_web_search')
  return parts.join(' / ')
}
