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
] as const

/**
 * Compact tool description for mcp__agim__call_agent.
 * Keep under ~900 chars so providers that truncate tool schemas stay usable.
 */
export const CALL_AGENT_TOOL_DESCRIPTION = [
  'Spawn a Subagent (nested worker; you keep the user-facing reply).',
  'Targets: (1) same-family Agim — isolate:true (reuse default model), role:"cheap" (llmRoles.cheap / flash), or backend:"<llmBackends.name>";',
  '(2) another registered adapter (claude-code, codex, …) via A2A.',
  'Brief MUST be self-contained: Objective + Output format + Boundaries + Done-when.',
  'Scale: single-fact / short edit → do it yourself (do not spawn for trivial one-step work);',
  '2–3 independent research/verify lanes → 1–3 Subagents; broad read-only search → fan-out with role:cheap when available;',
  'coding that writes the same file → do not parallel-write (serialize or split directories).',
  'After Subagents return: synthesize yourself — never ask the user to merge raw child output.',
  'Vacuous self-call without isolate/role/backend is refused. Guardrails: depth, ACL, per-turn cap.',
].join(' ')

/**
 * Parent system-prompt block (injected by buildSystemPrompt).
 * Complements the shorter tool description with decision heuristics.
 */
export function buildSubagentDelegationGuidance(): string {
  return [
    'Subagent delegation (mcp__agim__call_agent):',
    '  - You stay the user-facing owner. Subagents are nested workers (same-family Agim or cross-adapter A2A), not a sticky handoff.',
    '  - When to spawn: long / context-polluting / independently parallelizable work. Single-fact answers and short edits → do it yourself;',
    '    do not spawn for trivial one-step work.',
    '  - Brief four-piece (required in `prompt`): Objective; Output format; Boundaries (what not to redo); Done-when.',
    '  - Same-family: isolate:true reuses default model; role:"cheap" / backend:"…" when configured. Cross-adapter when another CLI is needed.',
    '  - Scale: 2–3 independent research/verify lanes → 1–3 Subagents; broad read-only explore → prefer role:cheap; coding that writes the same file → do not parallel-write (serialize or split dirs).',
    '  - Verification: after a substantive result, a fresh verifier Subagent can be valuable — give an exact claim + how to check it.',
    '  - Synthesize, don\'t delegate understanding: merge child summaries into one Chinese user reply; never dump raw child transcripts.',
  ].join('\n')
}
