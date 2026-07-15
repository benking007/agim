import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  _resetActiveRunsForTests,
  startActiveRun,
  upsertActiveRunStep,
  appendActiveRunChunk,
  finishActiveRun,
  getActiveRun,
  clearActiveRun,
} from '../../src/web/active-runs.js'

describe('active-runs', () => {
  beforeEach(() => { _resetActiveRunsForTests() })
  afterEach(() => { _resetActiveRunsForTests() })

  it('tracks steps and partial text while running', () => {
    startActiveRun({
      threadId: 'web-t1', runId: 'run-1', agent: 'agim', startedAt: 1000,
    })
    upsertActiveRunStep('web-t1', {
      id: 's1', kind: 'tool', label: 'search', status: 'running', startedAt: 1100,
    })
    appendActiveRunChunk('web-t1', 'Hel')
    appendActiveRunChunk('web-t1', 'lo')
    const snap = getActiveRun('web-t1')
    expect(snap?.status).toBe('running')
    expect(snap?.partialText).toBe('Hello')
    expect(snap?.steps).toHaveLength(1)
    expect(snap?.steps[0]?.label).toBe('search')
  })

  it('finishActiveRun closes open steps and keeps snapshot for replay', () => {
    startActiveRun({
      threadId: 'web-t1', runId: 'run-1', agent: 'agim', startedAt: 1000,
    })
    upsertActiveRunStep('web-t1', {
      id: 's1', kind: 'tool', label: 'search', status: 'running', startedAt: 1100,
    })
    finishActiveRun('web-t1', {
      status: 'success', finishedAt: 2000, durationMs: 1000, finalText: 'done',
    })
    const snap = getActiveRun('web-t1')
    expect(snap?.status).toBe('success')
    expect(snap?.partialText).toBe('done')
    expect(snap?.steps[0]?.status).toBe('success')
    expect(snap?.finishedAt).toBe(2000)
  })

  it('clearActiveRun drops the snapshot (new conversation)', () => {
    startActiveRun({
      threadId: 'web-t1', runId: 'run-1', agent: 'agim', startedAt: 1000,
    })
    clearActiveRun('web-t1')
    expect(getActiveRun('web-t1')).toBeUndefined()
  })
})
