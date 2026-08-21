/**
 * Session-scoped injectedContext dedupe (B1).
 *
 * Agim Agent dumps system+ephemeral into every turn's activity for the
 * accordion viewer. The skills-heavy system prompt (~tens of KB) was being
 * persisted verbatim on every assistant message, blowing up session JSON.
 *
 * Persist the full text once; later identical turns store a short marker.
 * History / SPA expand the marker back to the prior full copy for display.
 */

/** Wire + disk stub when this turn's injection matches an earlier full copy. */
export const INJECTED_CONTEXT_UNCHANGED_MARKER = '«agim-ic-unchanged»'

export function isInjectedContextUnchangedMarker(text: string | undefined | null): boolean {
  return (text?.trim() ?? '') === INJECTED_CONTEXT_UNCHANGED_MARKER
}

/** Persist full text, or the unchanged marker when equal to a prior full copy. */
export function dedupeInjectedContextForPersist(
  text: string | undefined,
  priorFull: string | undefined,
): string | undefined {
  const trimmed = text?.trim()
  if (!trimmed) return undefined
  if (priorFull && trimmed === priorFull) return INJECTED_CONTEXT_UNCHANGED_MARKER
  return trimmed
}

/** Resolve a stored value (full or marker) against the last known full text. */
export function resolveInjectedContextText(
  stored: string | undefined,
  priorResolved: string | undefined,
): string | undefined {
  if (!stored) return undefined
  if (isInjectedContextUnchangedMarker(stored)) return priorResolved
  return stored
}

type ActivityWithInjected = {
  injectedContext?: string
}

type MessageWithActivity = {
  activity?: ActivityWithInjected
}

/**
 * Walk messages oldest→newest and expand unchanged markers to the last full
 * injectedContext. Returns the same array reference when nothing changes.
 */
export function expandInjectedContextsInMessages<T extends MessageWithActivity>(
  messages: T[],
): T[] {
  let lastFull: string | undefined
  let changed = false
  const out: T[] = messages.map((m) => {
    const activity = m.activity
    const stored = activity?.injectedContext
    if (!stored) return m
    if (isInjectedContextUnchangedMarker(stored)) {
      if (!lastFull) return m
      changed = true
      return {
        ...m,
        activity: { ...activity, injectedContext: lastFull },
      }
    }
    lastFull = stored
    return m
  })
  return changed ? out : messages
}

/** Last full (non-marker) injectedContext in a message list, scanning newest first. */
export function findLastFullInjectedContext(
  messages: Array<{ activity?: { injectedContext?: string } }>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i]?.activity?.injectedContext
    if (text && !isInjectedContextUnchangedMarker(text)) return text
  }
  return undefined
}
