// plan-intent.ts — heuristic detection of "let's plan before acting"
// user intent (v1.2.135 / P3).
//
// Why this exists:
//   Users frequently phrase a task as "先想想 / first think / plan only
//   / don't act yet" but forget to /plan on. The model takes that as a
//   normal request and goes write-files-immediately, sometimes with
//   irreversible side effects.
//
// What it does:
//   detectPlanIntent(prompt) returns true if the prompt matches one of
//   the keyword patterns below. The router (router.ts:callAgentWithHistory)
//   checks this BEFORE invoking the agent; if env IMHUB_PLAN_INTENT_AUTO
//   is on AND plan mode is currently off AND intent is detected, the
//   router temporarily enables plan mode for that one turn (via the
//   opts.planMode flag passed to the adapter — does NOT mutate
//   session.planMode, so the next user message goes back to normal
//   unless they explicitly /plan on).
//
// What it does NOT do:
//   - It NEVER auto-exits plan mode. Once on, only /plan off or
//     native_exit_plan_mode (v1.2.131) can leave.
//   - It is OFF by default. Operators must IMHUB_PLAN_INTENT_AUTO=on.
//   - It does not "guess" — the keyword list is explicit + small. No
//     LLM round-trip, no semantic vector classification (too costly
//     for a feature this defensive).
//
// Why the keyword list is short:
//   - False positives are very costly (user wanted to act, gets stuck
//     in plan mode and has to manually /plan off).
//   - False negatives are cheap (no change vs. baseline).
//   - So we tilt heavily towards specificity. Each phrase is a clear
//     "do not act yet" signal in either CN or EN.

import { logger as rootLogger } from './logger.js'

const log = rootLogger.child({ component: 'plan-intent' })

/** Phrases that signal "discuss the plan first, don't execute".
 *  Matched as substrings (lowercase) — order doesn't matter. */
const PLAN_INTENT_PHRASES_DEFAULT = [
  // Chinese — most common intentional plan-mode triggers
  '先想想',
  '先想下',
  '先想一下',
  '先规划',
  '先讨论',
  '先看看',
  '先聊聊',
  '不要直接做',
  '不要直接动手',
  '只规划',
  '只讨论',
  '先别动手',
  // English — common in mixed-language operators
  'plan only',
  'plan first',
  'do not act yet',
  "don't act yet",
  'do not execute',
  "don't execute yet",
  'let us plan',
  "let's plan",
  'research first',
  'discuss first',
  'just plan',
  'dry run only',
  'dry-run only',
] as const

/** Parse IMHUB_PLAN_INTENT_PHRASES — comma-separated overrides. When
 *  set, REPLACES the default list (not merged) so operators can tighten
 *  or relax matching without code changes. Empty entries dropped. */
function resolvePhrases(): string[] {
  const raw = (process.env.IMHUB_PLAN_INTENT_PHRASES ?? '').trim()
  if (!raw) return [...PLAN_INTENT_PHRASES_DEFAULT]
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

/** Master switch. Operators flip via /settings/native-agent or env. */
export function isPlanIntentAutoEnabled(): boolean {
  const raw = (process.env.IMHUB_PLAN_INTENT_AUTO ?? '').toLowerCase().trim()
  return raw === 'on' || raw === '1' || raw === 'true' || raw === 'yes'
}

/** Detect plan-intent in a prompt. Returns the matched phrase (for
 *  logging / UX) or null when no phrase fires. Match is substring +
 *  case-insensitive. */
export function detectPlanIntent(prompt: string): string | null {
  if (!prompt) return null
  const lower = prompt.toLowerCase()
  const phrases = resolvePhrases()
  for (const phrase of phrases) {
    if (!phrase) continue
    if (lower.includes(phrase.toLowerCase())) {
      log.debug({ event: 'plan-intent.match', phrase, promptLen: prompt.length })
      return phrase
    }
  }
  return null
}

/** Helper for callers that just want a boolean. */
export function hasPlanIntent(prompt: string): boolean {
  return detectPlanIntent(prompt) != null
}

/** v1.2.135 — composed gate used by router. Returns the matched phrase
 *  iff: master switch on, AND prompt matches a phrase. Returns null
 *  otherwise. Callers use this to decide whether to flip planMode on
 *  for the current turn. */
export function shouldAutoEnterPlanMode(prompt: string): string | null {
  if (!isPlanIntentAutoEnabled()) return null
  return detectPlanIntent(prompt)
}
