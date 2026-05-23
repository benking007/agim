// persona — generates the small "what I know about you" block that
// router.ts prepends to every agent prompt when long-term memory is on.
//
// Design constraints (per the 2026-05-17 memory discussion):
//   - Always-on snippet, kept small (target 150-300 tokens) so the cost
//     per turn stays sane regardless of total memory size.
//   - Encourages the agent to USE memory: phrasing nudges it to call
//     memory_query for details beyond what the persona summary covers,
//     closing the "agent doesn't know it doesn't know" gap.
//   - Returns '' when no persona row exists for the user (new user → no
//     injection overhead).
//
// The summary itself is built by memory-distill.ts → upsertPersona based
// on consolidated facts. This module only renders the snippet.

import { getPersona, countFacts, userKey, type PersonaProfile } from './memory.js'
import { sanitizeForInjection } from './prompt-injection-guard.js'
import { formatAge } from './util/format-age.js'

export interface PersonaSnippetOpts {
  /** Per-conversation IM platform. */
  platform: string
  /** Per-conversation user id (the human across IMs). */
  userId: string
  /** Master switch — when false (default for new installs that haven't
   *  opted in yet), returns ''. Controlled by IMHUB_MEMORY_ENABLED. */
  enabled?: boolean
}

export function isMemoryEnabled(): boolean {
  const raw = (process.env.IMHUB_MEMORY_ENABLED || '').toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * Pure render helper — given a persona profile + fact count, build the
 * snippet text. Exported separately so unit tests can exercise the
 * P0 #4 row-age formatting without mocking SQLite-backed memory.
 *
 * When profile.updated_at is non-zero, the header carries a
 * "(summary last consolidated 3d ago)" tag so the agent can weight
 * stale facts against fresh ones without an extra tool call.
 */
export function renderPersonaSnippet(
  profile: PersonaProfile | null,
  factCount: number,
): string {
  if (!profile && factCount === 0) return ''

  const lines: string[] = ['[long-term memory]']
  if (profile?.summary) {
    const ageLabel = profile.updated_at
      ? ` (summary last consolidated ${formatAge(profile.updated_at)})`
      : ''
    lines.push(`What I know about this user (summary)${ageLabel}:`)
    lines.push(sanitizeForInjection(profile.summary.trim()))
  } else {
    lines.push(`I have ${factCount} stored fact(s) about this user but no consolidated summary yet.`)
  }
  lines.push('')
  lines.push(
    'Call `memory_query(query, k=5)` when the user references something they\'ve told you before — '
    + 'preferences, holdings, projects, names, places — to retrieve specific facts not in this summary. '
    + 'Call `memory_save({ what, ... })` when you learn something worth remembering long-term.'
  )
  lines.push('[/long-term memory]')
  return lines.join('\n')
}

/**
 * Build the persona snippet for prepending to a prompt. Empty string means
 * "don't prepend anything" — caller should just use the original prompt.
 */
export function buildPersonaSnippet(opts: PersonaSnippetOpts): string {
  const on = opts.enabled ?? isMemoryEnabled()
  if (!on) return ''
  if (!opts.platform || !opts.userId) return ''
  const key = userKey(opts.platform, opts.userId)
  const profile = getPersona(key)
  const factCount = countFacts(key)
  return renderPersonaSnippet(profile, factCount)
}

/** Convenience: same as buildPersonaSnippet but reads the row + count once
 *  for inspection (e.g. /memory list IM command). */
export function inspectPersona(platform: string, userId: string): {
  user_key: string
  profile: PersonaProfile | null
  factCount: number
} {
  const key = userKey(platform, userId)
  return {
    user_key: key,
    profile: getPersona(key),
    factCount: countFacts(key),
  }
}
