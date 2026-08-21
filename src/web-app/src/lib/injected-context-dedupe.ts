/**
 * Mirror of `src/core/injected-context-dedupe.ts` for the SPA (no core imports).
 * Keep the marker string identical to the server.
 */

export const INJECTED_CONTEXT_UNCHANGED_MARKER = '«agim-ic-unchanged»'

export function isInjectedContextUnchangedMarker(text: string | undefined | null): boolean {
  return (text?.trim() ?? '') === INJECTED_CONTEXT_UNCHANGED_MARKER
}

export function resolveInjectedContextText(
  stored: string | undefined,
  priorResolved: string | undefined,
): string | undefined {
  if (!stored) return undefined
  if (isInjectedContextUnchangedMarker(stored)) return priorResolved
  return stored
}

type Msg = { activity?: { injectedContext?: string } }

/** Expand unchanged markers oldest→newest. Same reference when unchanged. */
export function expandInjectedContextsInMessages<T extends Msg>(messages: T[]): T[] {
  let lastFull: string | undefined
  let changed = false
  const out = messages.map((m) => {
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

export function findLastFullInjectedContext(messages: Msg[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = messages[i]?.activity?.injectedContext
    if (text && !isInjectedContextUnchangedMarker(text)) return text
  }
  return undefined
}
