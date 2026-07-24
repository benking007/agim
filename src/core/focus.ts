// focus — per-thread attention anchor (Focus primitive).
//
// Product SSOT: docs/architecture/focus.md
// Storage: reuses goals.db rows (active = on, paused = off retained,
// cancelled = cleared). Completion semantics are NOT part of Focus.

import {
  appendProgress,
  applyGoalTimeoutBoost,
  getActiveGoal,
  getGoalById,
  listGoalsForThread,
  MAX_BODY_CHARS,
  MAX_PROGRESS_NOTES_INJECTED,
  MAX_TITLE_CHARS,
  resumeGoal,
  setActiveGoal,
  updateStatus,
  type GoalRow,
} from './goals.js'

export {
  MAX_BODY_CHARS,
  MAX_TITLE_CHARS,
  applyGoalTimeoutBoost as applyFocusTimeoutBoost,
}

export interface FocusRecord {
  id: number
  platform: string
  channelId: string
  threadId: string
  title: string
  body: string
  /** true → inject each turn */
  enabled: boolean
  updatedAt: string
}

function toFocus(row: GoalRow, enabled: boolean): FocusRecord {
  return {
    id: row.id,
    platform: row.platform,
    channelId: row.channelId,
    threadId: row.threadId,
    title: row.title,
    body: row.body,
    enabled,
    updatedAt: row.updatedAt,
  }
}

/** Active (on) focus for the thread, or null. */
export function getFocusOn(
  platform: string,
  channelId: string,
  threadId: string,
): FocusRecord | null {
  const row = getActiveGoal(platform, channelId, threadId)
  return row ? toFocus(row, true) : null
}

/** Retained focus: on first, else most recent paused (off) row. */
export function getFocusRetained(
  platform: string,
  channelId: string,
  threadId: string,
): FocusRecord | null {
  const on = getFocusOn(platform, channelId, threadId)
  if (on) return on
  const rows = listGoalsForThread(platform, channelId, threadId, 40)
  const paused = rows.find((r) => r.status === 'paused')
  return paused ? toFocus(paused, false) : null
}

export function hasFocusOn(platform: string, channelId: string, threadId: string): boolean {
  return !!getFocusOn(platform, channelId, threadId)
}

/** Set content and turn on (default). */
export function setFocus(input: {
  platform: string
  channelId: string
  threadId: string
  userId: string
  title: string
  body?: string
  replaceActive?: boolean
}): FocusRecord | null {
  const row = setActiveGoal({
    platform: input.platform,
    channelId: input.channelId,
    threadId: input.threadId,
    userId: input.userId,
    title: input.title,
    body: input.body,
    replaceActive: input.replaceActive,
    // Focus is not a completion-gated mission; keep evidence off by default.
    evidenceRequired: false,
  })
  return row ? toFocus(row, true) : null
}

/** Turn injection on. Uses retained paused content when present. */
export function focusOn(
  platform: string,
  channelId: string,
  threadId: string,
): { ok: true; focus: FocusRecord } | { ok: false; error: string } {
  const active = getFocusOn(platform, channelId, threadId)
  if (active) return { ok: true, focus: active }
  const retained = getFocusRetained(platform, channelId, threadId)
  if (!retained) {
    return { ok: false, error: 'no_focus' }
  }
  if (!resumeGoal(retained.id)) {
    return { ok: false, error: 'resume_failed' }
  }
  const on = getFocusOn(platform, channelId, threadId)
  if (!on) return { ok: false, error: 'resume_failed' }
  return { ok: true, focus: on }
}

/** Stop injection; keep title/body (paused). */
export function focusOff(
  platform: string,
  channelId: string,
  threadId: string,
): { ok: true; focus: FocusRecord } | { ok: false; error: string } {
  const active = getActiveGoal(platform, channelId, threadId)
  if (!active) {
    const retained = getFocusRetained(platform, channelId, threadId)
    if (retained) return { ok: true, focus: retained }
    return { ok: false, error: 'no_focus' }
  }
  if (!updateStatus(active.id, 'paused')) {
    return { ok: false, error: 'off_failed' }
  }
  const row = getGoalById(active.id)
  if (!row) return { ok: false, error: 'off_failed' }
  return { ok: true, focus: toFocus(row, false) }
}

/** Clear content and disable (cancel row). */
export function focusClear(
  platform: string,
  channelId: string,
  threadId: string,
): { ok: true } | { ok: false; error: string } {
  const active = getActiveGoal(platform, channelId, threadId)
  if (active) {
    appendProgress(active.id, 'system', 'focus cleared')
    if (!updateStatus(active.id, 'cancelled')) return { ok: false, error: 'clear_failed' }
    return { ok: true }
  }
  const retained = getFocusRetained(platform, channelId, threadId)
  if (!retained) return { ok: false, error: 'no_focus' }
  appendProgress(retained.id, 'system', 'focus cleared')
  if (!updateStatus(retained.id, 'cancelled')) return { ok: false, error: 'clear_failed' }
  return { ok: true }
}

/**
 * Wire-only Focus block. No complete_goal tokens — Focus is attention only.
 */
export function buildFocusSnippet(platform: string, channelId: string, threadId: string): string {
  const focus = getFocusOn(platform, channelId, threadId)
  if (!focus) return ''
  const lines: string[] = []
  lines.push(`[agim context — focus ON for this thread]`)
  lines.push(`Title: ${focus.title}`)
  if (focus.body) {
    const truncated = focus.body.length > 800 ? `${focus.body.slice(0, 800)}…` : focus.body
    lines.push('Body:')
    lines.push(truncated)
  }
  lines.push(
    'Stay on this focus unless the user explicitly changes topic or turns focus off.',
  )
  lines.push('')
  return lines.join('\n')
}

export function formatFocusShow(focus: FocusRecord): string {
  const flag = focus.enabled ? '✅ on（注入中）' : '⏸ off（保留内容，未注入）'
  const out: string[] = [
    `◎ Focus #${focus.id} — ${flag}`,
    `Title: ${focus.title}`,
    `Updated: ${focus.updatedAt} UTC`,
  ]
  if (focus.body) {
    out.push('', 'Body:', '```', focus.body, '```')
  }
  out.push('', '命令：`/focus on` · `/focus off` · `/focus clear` · `/focus set <标题>`')
  return out.join('\n')
}

/** @deprecated Prefer buildFocusSnippet — kept for callers still naming goal. */
export function buildGoalSnippetCompat(
  platform: string,
  channelId: string,
  threadId: string,
): string {
  return buildFocusSnippet(platform, channelId, threadId)
}

/** Progress notes still live on the underlying row; optional for Focus UX. */
export function appendFocusNote(
  platform: string,
  channelId: string,
  threadId: string,
  text: string,
): boolean {
  const on = getActiveGoal(platform, channelId, threadId)
  if (!on) return false
  return appendProgress(on.id, 'user', text)
}

export { MAX_PROGRESS_NOTES_INJECTED }
