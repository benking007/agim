import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { INJECTED_CONTEXT_UNCHANGED_MARKER } from '../../src/core/injected-context-dedupe.js'
import {
  _resetActiveRunsForTests,
  startActiveRun,
  upsertActiveRunStep,
  appendActiveRunChunk,
  finishActiveRun,
  getActiveRun,
  rekeyActiveRun,
  clearActiveRun,
  setActiveRunInjectedContext,
  injectedContextForWire,
  snapshotToPersistedActivity,
  INJECTED_CONTEXT_MAX_CHARS,
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

  it('late terminal Subagent steps update a finished run card', () => {
    startActiveRun({
      threadId: 'web-t1', runId: 'run-1', agent: 'agim', startedAt: 1000,
    })
    upsertActiveRunStep('web-t1', {
      id: 'agent-1', kind: 'agent', label: 'claude-code', status: 'running', startedAt: 1100,
    })
    finishActiveRun('web-t1', {
      status: 'success', finishedAt: 2000, durationMs: 1000, finalText: 'done',
    })
    const applied = upsertActiveRunStep('web-t1', {
      id: 'agent-1',
      kind: 'agent',
      label: 'claude-code',
      status: 'error',
      startedAt: 1100,
      finishedAt: 2100,
      preview: 'Stopped by user',
      jobId: 9,
    })
    expect(applied).toBe(true)
    const snap = getActiveRun('web-t1')
    expect(snap?.steps[0]?.status).toBe('error')
    expect(snap?.steps[0]?.preview).toBe('Stopped by user')
    expect(snap?.steps[0]?.jobId).toBe(9)
  })

  it('does not insert new steps after the run finished', () => {
    startActiveRun({
      threadId: 'web-t1', runId: 'run-1', agent: 'agim', startedAt: 1000,
    })
    finishActiveRun('web-t1', {
      status: 'success', finishedAt: 2000, durationMs: 1000, finalText: 'done',
    })
    const applied = upsertActiveRunStep('web-t1', {
      id: 'late', kind: 'agent', label: 'x', status: 'error', startedAt: 2100, finishedAt: 2100,
    })
    expect(applied).toBe(false)
    expect(getActiveRun('web-t1')?.steps).toHaveLength(0)
  })

  it('clearActiveRun drops the snapshot (new conversation)', () => {
    startActiveRun({
      threadId: 'web-t1', runId: 'run-1', agent: 'agim', startedAt: 1000,
    })
    clearActiveRun('web-t1')
    expect(getActiveRun('web-t1')).toBeUndefined()
  })

  it('keeps injected context in RAM and omits it from persisted activity', () => {
    startActiveRun({
      threadId: 'web-t1', runId: 'run-1', agent: 'agim', startedAt: 1000,
    })
    expect(setActiveRunInjectedContext('web-t1', '## System prompt\nhello')).toBe(true)
    expect(getActiveRun('web-t1')?.injectedContext).toContain('System prompt')
    const persisted = snapshotToPersistedActivity(getActiveRun('web-t1')!)
    expect('injectedContext' in persisted).toBe(false)
  })

  it('dedupes identical injected context on later live wire sends', () => {
    startActiveRun({
      threadId: 'web-t1', runId: 'run-1', agent: 'agim', startedAt: 1000,
    })
    const full = '## System prompt\nskills dump'
    setActiveRunInjectedContext('web-t1', full)
    expect(injectedContextForWire('web-t1', full)).toBe(full)
    expect('injectedContext' in snapshotToPersistedActivity(getActiveRun('web-t1')!)).toBe(false)

    finishActiveRun('web-t1', {
      status: 'success', finishedAt: 2000, durationMs: 1000, finalText: 'ok',
    })
    startActiveRun({
      threadId: 'web-t1', runId: 'run-2', agent: 'agim', startedAt: 3000,
    })
    setActiveRunInjectedContext('web-t1', full)
    expect(injectedContextForWire('web-t1', full)).toBe(INJECTED_CONTEXT_UNCHANGED_MARKER)
    expect('injectedContext' in snapshotToPersistedActivity(getActiveRun('web-t1')!)).toBe(false)
  })

  it('truncates oversized injected context', () => {
    startActiveRun({
      threadId: 'web-t1', runId: 'run-1', agent: 'agim', startedAt: 1000,
    })
    const huge = 'x'.repeat(INJECTED_CONTEXT_MAX_CHARS + 50)
    setActiveRunInjectedContext('web-t1', huge)
    const text = getActiveRun('web-t1')?.injectedContext ?? ''
    expect(text.length).toBeLessThan(huge.length)
    expect(text).toContain('[truncated')
  })

  it('rekeyActiveRun moves a live snapshot to the persisted thread id', () => {
    startActiveRun({
      threadId: 'web-ephemeral', runId: 'run-1', agent: 'agim', startedAt: 1000,
    })
    appendActiveRunChunk('web-ephemeral', 'partial')
    rekeyActiveRun('web-ephemeral', 'web-persisted')
    expect(getActiveRun('web-ephemeral')).toBeUndefined()
    expect(getActiveRun('web-persisted')?.runId).toBe('run-1')
    expect(getActiveRun('web-persisted')?.partialText).toBe('partial')
    expect(getActiveRun('web-persisted')?.threadId).toBe('web-persisted')
  })
})
