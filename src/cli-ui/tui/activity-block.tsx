/**
 * Ink ActivityBlock — Cursor-style in-thread run accordion for the TUI.
 *
 * Shows "执行中 · …" / "已完成 · N 次工具 · M 次技能 · 4.2s" plus step rows.
 * A2A: "等待子 Agent" while an agent step is running.
 * Always expanded in the TUI (no mouse accordion toggle).
 */

import { Box, Text } from 'ink'
import {
  countActivityStepKinds,
  findLiveActivityStep,
  findWaitingAgentStep,
  formatActivityDuration,
  formatActivityKindSummaryParts,
  listWaitingAgentSteps,
  type ChatActivity,
  type ChatActivityStep,
} from '../../core/chat-activity.js'

export interface ActivityBlockProps {
  activity: ChatActivity
  /** Terminal content width hint (reserved). */
  width?: number
}

function stepGlyph(step: ChatActivityStep): string {
  if (step.status === 'running' || step.status === 'pending') return '…'
  if (step.status === 'denied' || step.status === 'error') return '✗'
  if (step.status === 'success') return '✓'
  if (step.kind === 'approval') return '⚠'
  if (step.kind === 'ask') return '?'
  if (step.kind === 'agent') return '◆'
  if (step.kind === 'reflect') return '◇'
  return '·'
}

function stepKindBadge(step: ChatActivityStep): string | null {
  if (step.kind === 'approval') return '审批'
  if (step.kind === 'ask') return '提问'
  if (step.kind === 'skill') return '技能'
  if (step.kind === 'agent') {
    if (step.status === 'running' || step.status === 'pending') return '运行中'
    if (step.status === 'success') return '已完成'
    if (step.status === 'error' || step.status === 'denied') return '失败'
  }
  if (step.kind === 'reflect') return '步思'
  return null
}

function stepLabel(step: ChatActivityStep): string {
  if (step.kind === 'agent') return `→ ${step.label}`
  return step.label
}

export function ActivityBlock({ activity }: ActivityBlockProps): JSX.Element {
  const waitingAgents = listWaitingAgentSteps(activity)
  const waitingAgent = findWaitingAgentStep(activity)
  const liveStep = findLiveActivityStep(activity)
  const duration = formatActivityDuration(activity.durationMs)
  const running = activity.status === 'running'
  const stepCount = activity.steps.length

  let title: string
  if (running) {
    if (waitingAgents.length > 1) {
      title = `执行中 · ${waitingAgents.length} 个子代理`
    } else {
      const titleStep = waitingAgent ?? liveStep
      title = titleStep ? `执行中 · ${stepLabel(titleStep)}` : '执行中'
    }
  } else if (activity.status === 'error') {
    title = '失败'
  } else {
    const parts = ['已完成']
    parts.push(...formatActivityKindSummaryParts(countActivityStepKinds(activity), 'zh'))
    if (duration) parts.push(duration)
    title = parts.join(' · ')
  }

  return (
    <Box flexDirection="column" marginBottom={0}>
      <Text dimColor>
        <Text color={running ? 'cyan' : activity.status === 'error' ? 'red' : undefined}>
          {running ? '◉ ' : activity.status === 'error' ? '✗ ' : '◇ '}
        </Text>
        {title}
      </Text>
      {waitingAgents.length === 1 && (
        <Text dimColor>{`  等待子代理 · → ${waitingAgents[0].label}`}</Text>
      )}
      {waitingAgents.length > 1 && (
        <Box flexDirection="column">
          <Text dimColor>{`  等待 ${waitingAgents.length} 个子代理`}</Text>
          {waitingAgents.map((step) => (
            <Text key={step.id} dimColor>{`    → ${step.label}`}</Text>
          ))}
        </Box>
      )}
      {stepCount === 0 && running && (
        <Text dimColor>  等待工具活动…</Text>
      )}
      {activity.steps.map((step) => {
        const badge = stepKindBadge(step)
        const preview = step.preview
          ? (step.preview.length > 120 ? `${step.preview.slice(0, 120)}…` : step.preview)
          : undefined
        return (
          <Box key={step.id} flexDirection="column" marginLeft={1}>
            <Text>
              <Text
                color={
                  step.status === 'error' || step.status === 'denied'
                    ? 'red'
                    : step.status === 'success'
                      ? 'green'
                      : step.kind === 'agent'
                        ? 'magenta'
                        : undefined
                }
              >
                {stepGlyph(step)}
              </Text>
              {' '}
              <Text>{stepLabel(step)}</Text>
              {badge ? <Text dimColor>{`  ${badge}`}</Text> : null}
            </Text>
            {preview ? <Text dimColor>{`  ${preview}`}</Text> : null}
          </Box>
        )
      })}
      {activity.error ? (
        <Text color="red">{`  ${activity.error}`}</Text>
      ) : null}
    </Box>
  )
}
