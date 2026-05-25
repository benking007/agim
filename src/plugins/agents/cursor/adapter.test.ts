// Cursor adapter — focused unit tests. We can't exercise an actual
// spawn under bun:test (the real cursor-agent binary may not be on the
// test box), so we hit the pure helpers + verify event-parsing logic
// against fixtures captured from a real run.

import { describe, it, expect } from 'bun:test'
import { CursorAdapter } from './index.js'

// extractText / inspectEvent are protected — narrow the type for tests.
class CursorAdapterTestable extends CursorAdapter {
  exposeExtractText(event: unknown): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).extractText(event)
  }
  exposeInspectEvent(event: unknown, opts: Record<string, unknown>): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).inspectEvent(event, opts)
  }
  exposeBuildArgs(prompt: string, opts: Record<string, unknown>): string[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).buildArgs(prompt, opts)
  }
}

const adapter = new CursorAdapterTestable()

describe('CursorAdapter — identity', () => {
  it('exposes name + aliases + kind', () => {
    expect(adapter.name).toBe('cursor')
    expect(adapter.aliases).toEqual(['cs', 'cur'])
    expect(adapter.kind).toBe('cli')
  })
})

describe('CursorAdapter — buildArgs', () => {
  it('emits headless mode + trust + force + approve-mcps by default', () => {
    const args = adapter.exposeBuildArgs('hello', {})
    expect(args).toContain('--print')
    expect(args).toContain('--output-format')
    expect(args).toContain('stream-json')
    expect(args).toContain('--trust')
    expect(args).toContain('--force')
    expect(args).toContain('--approve-mcps')
    expect(args[args.length - 1]).toBe('hello')
  })

  it('appends --model when opts.model set', () => {
    const args = adapter.exposeBuildArgs('hi', { model: 'sonnet-4-thinking' })
    const idx = args.indexOf('--model')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('sonnet-4-thinking')
  })

  it('appends --plan when planMode true', () => {
    const args = adapter.exposeBuildArgs('design X', { planMode: true })
    expect(args).toContain('--plan')
  })

  it('appends --resume <id> when agentSessionId given', () => {
    const args = adapter.exposeBuildArgs('next', { agentSessionId: 'sess-abc' })
    const idx = args.indexOf('--resume')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx + 1]).toBe('sess-abc')
  })

  it('does NOT add resume when session id is absent', () => {
    const args = adapter.exposeBuildArgs('first turn', {})
    expect(args).not.toContain('--resume')
    expect(args).not.toContain('--continue')
  })
})

describe('CursorAdapter — extractText', () => {
  it('returns text from assistant events with text content', () => {
    const event = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      session_id: 'sess-1',
    }
    expect(adapter.exposeExtractText(event)).toBe('hi there')
  })

  it('returns empty string for system events', () => {
    expect(adapter.exposeExtractText({ type: 'system', subtype: 'init', session_id: 's' })).toBe('')
  })

  it('returns empty string for tool_call events', () => {
    expect(adapter.exposeExtractText({ type: 'tool_call', subtype: 'started', call_id: 'c1' })).toBe('')
  })

  it('returns empty string for result events (already captured via assistant deltas)', () => {
    expect(adapter.exposeExtractText({ type: 'result', subtype: 'success', result: 'final', session_id: 's' })).toBe('')
  })

  it('returns empty string for thinking events (deliberately swallowed)', () => {
    expect(adapter.exposeExtractText({ type: 'thinking', subtype: 'delta', text: 'pondering' })).toBe('')
  })
})

describe('CursorAdapter — inspectEvent', () => {
  it('captures session_id from system.init via onAgentSessionId callback', () => {
    let captured = ''
    adapter.exposeInspectEvent(
      { type: 'system', subtype: 'init', session_id: 'sess-xyz' },
      { onAgentSessionId: (id: string) => { captured = id } },
    )
    expect(captured).toBe('sess-xyz')
  })

  it('does NOT re-capture when caller already supplied agentSessionId', () => {
    let captured = ''
    adapter.exposeInspectEvent(
      { type: 'system', subtype: 'init', session_id: 'sess-new' },
      { agentSessionId: 'sess-existing', onAgentSessionId: (id: string) => { captured = id } },
    )
    expect(captured).toBe('')
  })

  it('forwards token usage from result event via onUsage callback', () => {
    const deltas: Array<Record<string, number | undefined>> = []
    adapter.exposeInspectEvent(
      {
        type: 'result',
        subtype: 'success',
        usage: { inputTokens: 3, outputTokens: 42, cacheReadTokens: 14900, cacheWriteTokens: 19629 },
      },
      { onUsage: (d: Record<string, number | undefined>) => { deltas.push(d) } },
    )
    expect(deltas).toHaveLength(1)
    expect(deltas[0].tokensInput).toBe(3 + 14900 + 19629)
    expect(deltas[0].tokensOutput).toBe(42)
  })

  it('skips usage callback when usage is absent', () => {
    let called = false
    adapter.exposeInspectEvent(
      { type: 'result', subtype: 'success', result: 'ok' },
      { onUsage: () => { called = true } },
    )
    expect(called).toBe(false)
  })
})
