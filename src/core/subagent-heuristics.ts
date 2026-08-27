/**
 * Phase A3 — Subagent decompose / when-to-spawn heuristics.
 *
 * SSOT for parent system-prompt guidance and mcp__agim__call_agent tool
 * description. Concept: docs/architecture/subagent.md §5.
 */

/** Keywords locked by unit tests (anti-regression). */
export const SUBAGENT_HEURISTIC_KEYWORDS = [
  'objective',
  'output format',
  'boundaries',
  'done-when',
  'do not spawn for trivial',
  'same-family',
  'do not parallel-write',
  'synthesize',
  'absolute path',
  'see above',
] as const

/**
 * Compact tool description for mcp__agim__call_agent.
 * Keep under ~1100 chars so providers that truncate tool schemas stay usable.
 */
export const CALL_AGENT_TOOL_DESCRIPTION = [
  'Spawn ONE Subagent (nested worker; you keep the user-facing reply).',
  'For 2+ independent lanes prefer mcp__agim__call_agents (batch fan-out).',
  'Targets: (1) same-family Agim — prefer backend:"<llmBackends.name>" (concrete model backend);',
  'isolate:true reuses the parent default model; role:"cheap" only when llmRoles.cheap is configured (optional alias).',
  '(2) another registered adapter (claude-code, codex, …) via A2A.',
  'Brief MUST be self-contained: Objective + Output format + Boundaries + Done-when.',
  'Output format MUST require: key findings in the child FINAL message;',
  'if the child also writes a file, it must cite the absolute path;',
  'forbid empty「见上文」/「see above」with no substance.',
  'Scale: single-fact / short edit → do it yourself (do not spawn for trivial one-step work);',
  '2–3 independent research/verify lanes → call_agents; broad read-only search → fan-out with a cheaper backend when available;',
  'coding that writes the same file → do not parallel-write (serialize or split directories).',
  'After Subagents return: synthesize yourself — never ask the user to merge raw child output.',
  'Vacuous self-call without isolate/role/backend is refused. Guardrails: depth, ACL, per-turn cap.',
  'Unknown keys refused. Optional: outputFormat, maxDepth (≤ AGIM_A2A_MAX_DEPTH), allowedTools (same-family Agim only).',
].join(' ')

/** Compact tool description for mcp__agim__call_agents (Phase B). */
export const CALL_AGENTS_TOOL_DESCRIPTION = [
  'Spawn MULTIPLE Subagents in one call (fan-out / join). You keep the user-facing reply.',
  'Use when 2–3 lanes are independent (research/verify/explore). Do not use for trivial one-step work.',
  'Each tasks[] item needs a self-contained brief (Objective + Output format + Boundaries + Done-when).',
  'Output format: key findings in each child FINAL message; file writes must cite absolute path; no empty see above / 见上文.',
  'Do not parallel-write the same file — split directories or serialize writers.',
  'Failure mode: allSettled — one child fail/timeout/cancel does not kill siblings; synthesize all results.',
  'Same-family: prefer backend=; isolate:true reuses default model. Guardrails: depth, ACL, per-turn cap, parallel max.',
  'Unknown keys refused. Optional per task: outputFormat, maxDepth, allowedTools (Agim only).',
].join(' ')

/**
 * Parent system-prompt block (injected by buildSystemPrompt).
 * Complements the shorter tool description with decision heuristics.
 * Also read by Subagents (same system prompt) — deliverable rules apply when YOU are the child.
 */
export function buildSubagentDelegationGuidance(extra?: {
  backends?: string[]
  roles?: string[]
  /** Preformatted specialty catalog (from agent-profiles). */
  agentProfilesCatalog?: string
  /** Operator-configured task → agent/backend cheat sheet. */
  dispatchCheatSheet?: string
}): string {
  const lines = [
    'Subagent delegation (mcp__agim__call_agent / mcp__agim__call_agents):',
    '  - You stay the user-facing owner. Subagents are nested workers (same-family Agim or cross-adapter A2A), not a sticky handoff.',
    '  - When to spawn: long / context-polluting / independently parallelizable work. Single-fact answers and short edits → do it yourself;',
    '    do not spawn for trivial one-step work.',
    '  - One lane → call_agent. Two or more independent lanes → call_agents (batch fan-out; join then synthesize).',
    '  - Brief four-piece (required in each `prompt`): Objective; Output format; Boundaries (what not to redo); Done-when.',
    '  - Output format contract (parent MUST ask; child MUST deliver): key findings (tables/lists/numbers) in the child FINAL message;',
    '    if also writing a file, cite the absolute path; never only「见上文」/「see above」/「见文件」without substance.',
    '  - When YOU are a Subagent: your job.result / Portal「执行结果」IS your final message — put the answer there, not only in a file.',
    '  - When YOU are a Subagent: do NOT call mcp__agim__ask_user or loop_verdict — HITL and Loop verdict are parent-only;',
    '    put clarifying needs / blockers in your FINAL message and return.',
    '  - Same-family: prefer backend:"<llmBackends.name>" (concrete). isolate:true reuses default model.',
    '    role:"cheap" / role:"finance" are optional aliases when those llmRoles are configured — do not assume they exist.',
    '  - Cross-adapter: pick agent= using the specialty catalog below (and availability). Prefer fit over habit.',
    '  - Follow the Task → dispatch cheat sheet below when present (operator-configured agent/backend).',
    '  - Capability fit (see catalog caps=): coding → CLI like codex/claude-code; finance / zhWriting → Agim + configured finance backend (or caps-strong backend); reasoning/dataCheck → either when strong;',
    '    Image attachments are routed automatically (vision subagent → parent); do not spawn another vision child for the same files.',
    '  - Scale: 2–3 independent research/verify lanes → call_agents; broad read-only explore → cheaper backend; coding that writes the same file → do not parallel-write (serialize or split dirs).',
    '  - Verification: after a substantive result, a fresh verifier Subagent can be valuable — give an exact claim + how to check it.',
    '  - Synthesize, don\'t delegate understanding: merge child summaries into one Chinese user reply; never dump raw child transcripts.',
  ]
  const cheat = (extra?.dispatchCheatSheet || '').trim()
  if (cheat) {
    lines.push('', cheat)
  }
  const catalog = (extra?.agentProfilesCatalog || '').trim()
  if (catalog) {
    lines.push('', catalog)
  }
  return lines.join('\n')
}

/** Append live backend/role roster so the model can pick real names. */
function appendBackendRoleRoster(
  base: string,
  extra?: { backends?: string[]; roles?: string[] },
): string {
  const backends = (extra?.backends ?? []).filter(Boolean)
  const roles = (extra?.roles ?? []).filter(Boolean)
  const bits = [base]
  if (backends.length > 0) {
    bits.push(`Configured llmBackends (prefer these in backend=): ${backends.join(', ')}.`)
  } else {
    bits.push('No llmBackends configured — use isolate:true for same-family, or a cross-adapter id.')
  }
  if (roles.length > 0) {
    bits.push(`Optional llmRoles aliases: ${roles.join(', ')}.`)
  }
  return bits.join(' ')
}

export function buildCallAgentToolDescription(extra?: {
  backends?: string[]
  roles?: string[]
  agentProfilesCatalog?: string
}): string {
  const base = appendBackendRoleRoster(CALL_AGENT_TOOL_DESCRIPTION, extra)
  const catalog = (extra?.agentProfilesCatalog || '').trim()
  if (!catalog) return base
  // Keep tool schema compact — one-line hint; full catalog is in system prompt.
  return `${base} Prefer cross-adapter agent= using specialty fit (see system specialty catalog).`
}

export function buildCallAgentsToolDescription(extra?: {
  backends?: string[]
  roles?: string[]
  agentProfilesCatalog?: string
}): string {
  const base = appendBackendRoleRoster(CALL_AGENTS_TOOL_DESCRIPTION, extra)
  const catalog = (extra?.agentProfilesCatalog || '').trim()
  if (!catalog) return base
  return `${base} Prefer each tasks[].agent by specialty fit (see system specialty catalog).`
}
