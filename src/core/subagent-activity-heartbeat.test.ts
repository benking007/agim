import { describe, expect, it } from 'bun:test'
import type { ToolActivityStep } from './types.js'
import {
  ACTIVITY_HEARTBEAT_MS_DEFAULT,
  ACTIVITY_HEARTBEAT_MS_MAX,
  ACTIVITY_HEARTBEAT_MS_MIN,
  buildActivityHeartbeatStep,
  createSubagentActivityHeartbeat,
  resolveActivityHeartbeatMs,
} from './subagent-activity-heartbeat.js'

describe('resolveActivityHeartbeatMs', () => {
  it('defaults to 45s', () => {
    expect(resolveActivityHeartbeatMs({})).toBe(ACTIVITY_HEARTBEAT_MS_DEFAULT)
  })

  it('clamps to 30–60s', () => {
    expect(resolveActivityHeartbeatMs({
      AGIM_SUBAGENT_ACTIVITY_HEARTBEAT_MS: '5000',
    })).toBe(ACTIVITY_HEARTBEAT_MS_MIN)
    expect(resolveActivityHeartbeatMs({
      AGIM_SUBAGENT_ACTIVITY_HEARTBEAT_MS: '120000',
    })).toBe(ACTIVITY_HEARTBEAT_MS_MAX)
    expect(resolveActivityHeartbeatMs({
      AGIM_SUBAGENT_ACTIVITY_HEARTBEAT_MS: '40000',
    })).toBe(40_000)
  })

  it('ignores invalid values', () => {
    expect(resolveActivityHeartbeatMs({
      AGIM_SUBAGENT_ACTIVITY_HEARTBEAT_MS: 'nope',
    })).toBe(ACTIVITY_HEARTBEAT_MS_DEFAULT)
    expect(resolveActivityHeartbeatMs({
      AGIM_SUBAGENT_ACTIVITY_HEARTBEAT_MS: '0',
    })).toBe(ACTIVITY_HEARTBEAT_MS_DEFAULT)
  })
})

describe('buildActivityHeartbeatStep', () => {
  it('keeps the lane running and stamps heartbeatAt', () => {
    const step = buildActivityHeartbeatStep({
      id: 'a2a-3396',
      label: 'cursor',
      startedAt: 1_000,
      now: 46_000,
      jobId: 3396,
      lastTool: { label: 'agim_exec', status: 'running', at: 12_000 },
    })
    expect(step).toMatchObject({
      id: 'a2a-3396',
      kind: 'agent',
      label: 'cursor',
      status: 'running',
      startedAt: 1_000,
      jobId: 3396,
      heartbeatAt: 46_000,
      lastTool: { label: 'agim_exec', status: 'running', at: 12_000 },
    })
    expect(step.finishedAt).toBeUndefined()
    expect(step.preview).toBeUndefined()
  })
})

describe('createSubagentActivityHeartbeat', () => {
  it('emits lastTool + heartbeatAt on each tick and stops cleanly', () => {
    const emits: ToolActivityStep[] = []
    let now = 1_000
    let tick: (() => void) | undefined
    let cleared = 0
    const hb = createSubagentActivityHeartbeat({
      emit: (step) => { emits.push(step) },
      stepId: 'a2a-1',
      label: 'cursor',
      startedAt: 1_000,
      jobId: 3396,
      intervalMs: 45_000,
      now: () => now,
      setIntervalFn: (fn) => {
        tick = fn as () => void
        return 1 as unknown as ReturnType<typeof setInterval>
      },
      clearIntervalFn: () => { cleared += 1 },
    })
    hb.start()
    hb.noteProgress({
      lastTool: { label: 'agim_exec', status: 'running', at: 1_200 },
    })
    expect(emits).toHaveLength(0)
    now = 46_000
    tick?.()
    expect(emits).toHaveLength(1)
    expect(emits[0]?.heartbeatAt).toBe(46_000)
    expect(emits[0]?.lastTool).toEqual({
      label: 'agim_exec',
      status: 'running',
      at: 1_200,
    })
    hb.stop()
    expect(cleared).toBe(1)
    now = 91_000
    tick?.()
    expect(emits).toHaveLength(1)
  })
})
