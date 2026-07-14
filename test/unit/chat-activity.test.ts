import { describe, expect, it } from 'bun:test'
import {
  appendApprovalStep,
  appendAskStep,
  createChatActivity,
  findWaitingAgentStep,
  finishActivity,
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
    })
    expect(findWaitingAgentStep(activity)?.label).toBe('claude-code')
    activity = mergeToolActivityStep(activity, {
      id: 'a2a-9',
      kind: 'agent',
      label: 'claude-code',
      status: 'success',
      startedAt: 1200,
      finishedAt: 2000,
    })
    expect(findWaitingAgentStep(activity)).toBeUndefined()
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
})
