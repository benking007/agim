/**
 * Scroll-follow fingerprint for chat activity.
 *
 * `steps.length` alone misses mid-turn Plan updates (stable
 * `agim-plan-checklist` id) and Subagent status flips on the same row.
 */

import type { ChatActivity } from '@/hooks/use-chat'
import { extractLatestTodoItems } from '@/lib/activity-todo'

export function activityFollowSignal(activity: ChatActivity | undefined | null): string {
  if (!activity?.steps?.length) return '0'
  const todo = extractLatestTodoItems(activity)
  const todoSig = todo
    ? todo.map((it) => `${it.status}:${it.content}`).join('|')
    : ''
  const stepSig = activity.steps
    .map((st) => `${st.id}:${st.status}:${st.kind ?? 'tool'}:${st.preview?.length ?? 0}`)
    .join(',')
  return `${activity.status}:${activity.steps.length}:${stepSig}:${todoSig}`
}
