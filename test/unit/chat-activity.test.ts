import { describe, expect, it } from 'bun:test'
import {
  appendApprovalStep,
  appendAskStep,
  countActivityStepKinds,
  createChatActivity,
  findWaitingAgentStep,
  finishActivity,
  formatActivityKindSummaryParts,
  formatWaitingSubagentLabels,
  listWaitingAgentSteps,
  mergeToolActivityStep,
  resolveApprovalStep,
  resolveAskStep,
} from '../../src/core/chat-activity.js'

describe('chat-activity helpers', () => {
  it('merges tool steps by id (running → success)', () => {
    let activity = createChatActivity('run-1', 1000)
    activity = mergeToolActivityStep(activity, {
      id: 'tc-1',
      kind: 'tool',
      label: 'agim_read',
      status: 'running',
      startedAt: 1100,
      preview: '{"path":"a.ts"}',
    })
    activity = mergeToolActivityStep(activity, {
      id: 'tc-1',
      kind: 'tool',
      label: 'agim_read',
      status: 'success',
      startedAt: 1100,
      finishedAt: 1400,
      preview: 'ok',
    })
    expect(activity.steps).toHaveLength(1)
    expect(activity.steps[0]).toMatchObject({
      id: 'tc-1',
      status: 'success',
      preview: 'ok',
    })
  })

  it('tracks A2A agent waiting + completion', () => {
    let activity = createChatActivity('run-2', 1000)
    activity = mergeToolActivityStep(activity, {
      id: 'a2a-9',
      kind: 'agent',
      label: 'claude-code',
      status: 'running',
      startedAt: 1200,
      jobId: 9,
    })
    expect(findWaitingAgentStep(activity)?.label).toBe('claude-code')
    expect(activity.steps[0]?.jobId).toBe(9)
    activity = mergeToolActivityStep(activity, {
      id: 'a2a-9',
      kind: 'agent',
      label: 'claude-code',
      status: 'success',
      startedAt: 1200,
      finishedAt: 2000,
    })
    expect(findWaitingAgentStep(activity)).toBeUndefined()
    expect(activity.steps[0]?.jobId).toBe(9)
  })

  it('lists multiple waiting Subagent steps in order', () => {
    let activity = createChatActivity('run-multi', 1000)
    activity = mergeToolActivityStep(activity, {
      id: 'a2a-1',
      kind: 'agent',
      label: 'agim/cheap',
      status: 'running',
      startedAt: 1100,
      jobId: 1,
    })
    activity = mergeToolActivityStep(activity, {
      id: 'a2a-2',
      kind: 'agent',
      label: 'claude-code',
      status: 'running',
      startedAt: 1200,
      jobId: 2,
    })
    const waiting = listWaitingAgentSteps(activity)
    expect(waiting.map((s) => s.label)).toEqual(['agim/cheap', 'claude-code'])
    expect(findWaitingAgentStep(activity)?.label).toBe('claude-code')
    expect(formatWaitingSubagentLabels(waiting)).toBe('agim/cheap, claude-code')
  })

  it('folds approval/ask dock events into steps', () => {
    let activity = createChatActivity('run-3', 1000)
    activity = appendApprovalStep(activity, {
      messageId: 'apv-1',
      toolName: 'agim_exec',
      inputJson: '{"cmd":"ls"}',
    })
    activity = appendAskStep(activity, {
      messageId: 'ask-1',
      label: 'Which file?',
      body: 'pick one',
    })
    expect(activity.steps.map((s) => s.kind)).toEqual(['approval', 'ask'])
    activity = resolveApprovalStep(activity, {
      messageId: 'apv-1',
      decision: 'allowed',
    })
    activity = resolveAskStep(activity, {
      messageId: 'ask-1',
      finalText: 'src/a.ts',
    })
    expect(activity.steps[0]?.status).toBe('success')
    expect(activity.steps[1]).toMatchObject({
      status: 'success',
      preview: 'src/a.ts',
    })
  })

  it('finishActivity closes open steps', () => {
    let activity = createChatActivity('run-4', 1000)
    activity = mergeToolActivityStep(activity, {
      id: 'tc',
      kind: 'tool',
      label: 'agim_read',
      status: 'running',
      startedAt: 1001,
    })
    activity = finishActivity(activity, { status: 'success', finishedAt: 2000 })
    expect(activity.status).toBe('success')
    expect(activity.durationMs).toBe(1000)
    expect(activity.steps[0]?.status).toBe('success')
  })

  it('counts step kinds and formats summary parts', () => {
    let activity = createChatActivity('run-5', 1000)
    activity = mergeToolActivityStep(activity, {
      id: 't1', kind: 'tool', label: 'agim_read', status: 'success', startedAt: 1,
    })
    activity = mergeToolActivityStep(activity, {
      id: 'sk1', kind: 'skill', label: 'skill_x', status: 'success', startedAt: 2,
    })
    activity = appendApprovalStep(activity, { messageId: 'apv-1', toolName: 'agim_exec' })
    activity = mergeToolActivityStep(activity, {
      id: 'a1', kind: 'agent', label: 'claude-code', status: 'success', startedAt: 3,
    })
    const counts = countActivityStepKinds(activity)
    expect(counts).toEqual({
      tools: 1, skills: 1, agents: 1, approvals: 1, asks: 0, total: 4,
    })
    expect(formatActivityKindSummaryParts(counts, 'en')).toEqual([
      '1 tool', '1 skill', '1 agent', '1 approval',
    ])
    expect(formatActivityKindSummaryParts(counts, 'zh')).toEqual([
      '1 次工具', '1 次技能', '1 次协作', '1 次审批',
    ])
  })
})
