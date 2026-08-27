/**
 * Phase A3 — Subagent decompose / when-to-spawn heuristics.
 *
 * SSOT for parent system-prompt guidance and mcp__agim__call_agent tool
 * description. Concept: docs/architecture/subagent.md §5.
 *
 * Product rule: parent orchestrates (delegate first). Child executes.
 */

/** Keywords locked by unit tests (anti-regression). */
export const SUBAGENT_HEURISTIC_KEYWORDS = [
  'objective',
  'output format',
  'boundaries',
  'done-when',
  'delegate first',
  'same-family',
  'do not parallel-write',
  'synthesize',
  'absolute path',
  'see above',
  'do not re-delegate',
] as const

/**
 * Compact tool description for mcp__agim__call_agent.
 * Keep under ~1100 chars so providers that truncate tool schemas stay usable.
 */
export const CALL_AGENT_TOOL_DESCRIPTION = [
  'Spawn ONE Subagent (you keep the user-facing reply). Delegate first: if a worker exists, do not write/edit/exec yourself.',
  '2+ independent lanes → mcp__agim__call_agents.',
  'Targets: same-family Agim prefer backend:"<llmBackends.name>"; isolate:true reuses the default model;',
  'role:"cheap" only if llmRoles.cheap is configured. Or another adapter (claude-code, codex, …) via A2A.',
  'Brief MUST include Objective + Output format + Boundaries + Done-when.',
  'Output format: key findings in the child FINAL message; file writes cite the absolute path; no empty「见上文」/「see above」。',
  'When YOU are a Subagent: execute with native tools; do not re-delegate unless the brief asks.',
  'Hands-on only: greetings / single-fact / no worker. Coding / finance / research → spawn.',
  'Same-file coding → do not parallel-write. After return: synthesize yourself — never ask the user to merge.',
  'Vacuous self-call without isolate/role/backend is refused. Guardrails: depth, ACL, per-turn cap.',
  'Unknown keys refused. Optional: outputFormat, maxDepth, allowedTools (same-family Agim only).',
].join(' ')

/** Compact tool description for mcp__agim__call_agents (Phase B). */
export const CALL_AGENTS_TOOL_DESCRIPTION = [
  'Spawn MULTIPLE Subagents in one call (fan-out / join). You keep the user-facing reply.',
  'Delegate first: do not do independent lanes yourself when workers exist.',
  'Use when 2–3 lanes are independent (research/verify/explore). Hands-on only if no dispatchable worker.',
  'Each tasks[] item needs a self-contained brief (Objective + Output format + Boundaries + Done-when).',
  'Output format: key findings in each child FINAL message; file writes must cite absolute path; no empty see above / 见上文.',
  'When YOU are a Subagent: execute; do not re-delegate unless the brief explicitly asks.',
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
  /** Ranked live picks (caps + availability). */
  livePreferredPicks?: string
}): string {
  const lines = [
    'Subagent delegation (mcp__agim__call_agent / mcp__agim__call_agents):',
    '  - You stay the user-facing owner. Subagents are nested workers (same-family Agim or cross-adapter A2A), not a sticky handoff.',
    '  - Delegate first: if a dispatchable worker exists, spawn it. Do not write/edit/exec/test yourself when someone else can.',
    '  - Hands-on only: greetings / single-fact answers / ask_user / synthesize / Plan-mode reads / Loop ALIGNING / no dispatchable worker.',
    '  - Short edits still spawn when a coding worker is listed below. Failures: pick the next live pick — do not take over unless the list is empty.',
    '  - One lane → call_agent. Two or more independent lanes → call_agents (batch fan-out; join then synthesize).',
    '  - Brief four-piece (required in each `prompt`): Objective; Output format; Boundaries (what not to redo); Done-when.',
    '  - Output format contract (parent MUST ask; child MUST deliver): key findings (tables/lists/numbers) in the child FINAL message;',
    '    if also writing a file, cite the absolute path; never only「见上文」/「see above」/「见文件」without substance.',
    '  - When YOU are a Subagent: your job.result / Portal「执行结果」IS your final message — put the answer there, not only in a file.',
    '  - When YOU are a Subagent: execute with native tools; do not re-delegate unless the brief explicitly asks for further fan-out;',
    '    do NOT call mcp__agim__ask_user or loop_verdict — HITL and Loop verdict are parent-only;',
    '    put clarifying needs / blockers in your FINAL message and return.',
    '  - Same-family: prefer backend:"<llmBackends.name>" (concrete). isolate:true reuses default model.',
    '    role:"cheap" / role:"finance" are optional aliases when those llmRoles are configured — do not assume they exist.',
    '    Vacuous agent:"agim" without isolate/backend/role is refused — add one of those knobs.',
    '  - Cross-adapter: pick agent= from live preferred picks (caps rank) then the specialty catalog. Prefer fit over habit.',
    '  - Follow the Task → dispatch cheat sheet below when present (operator-configured agent/backend).',
    '  - Capability fit (see catalog caps=): coding → highest coding= CLI that is listed as available;',
    '    finance / zhWriting → Agim + configured finance/zh backend (or caps-strong backend); reasoning/dataCheck → either when strong;',
    '    Image attachments are routed automatically (vision subagent → parent); do not spawn another vision child for the same files.',
    '  - Scale: 2–3 independent research/verify lanes → call_agents; broad read-only explore → cheaper backend; coding that writes the same file → do not parallel-write (serialize or split dirs).',
    '  - Verification: after a substantive result, a fresh verifier Subagent can be valuable — give an exact claim + how to check it.',
    '  - Synthesize, don\'t delegate understanding: merge child summaries into one Chinese user reply; never dump raw child transcripts.',
    '  - Plan mode: name who you will dispatch; call_agent only after the user exits/approves the plan.',
  ]
  const picks = (extra?.livePreferredPicks || '').trim()
  if (picks) {
    lines.push('', picks)
  }
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
