// Tests for the Stage-6 /agents output: every adapter renders with its
// kind tag + aliases + describe() summary, and native is just another
// peer row.
//
// We invoke handleBuiltInCommand('agents', ctx) directly with a stub
// registry adapter so we don't pull in real agent CLIs. RouteContext
// values are placeholders since /agents doesn't read them.

import { describe, it, expect, beforeEach } from 'bun:test'
import { handleBuiltInCommand } from './builtin.js'
import { registry } from '../registry.js'
import type { AgentAdapter } from '../types.js'
import type { RouteContext } from '../router.js'

function stubAdapter(name: string, kind: AgentAdapter['kind'], aliases: string[], summary?: string): AgentAdapter {
  return {
    name,
    aliases,
    kind,
    isAvailable: async () => true,
    async *sendPrompt() { yield '' },
    describe: summary ? () => summary : undefined,
  }
}

const CTX = {
  platform: 'test',
  channelId: 'c',
  threadId: 't',
  defaultAgent: 'agim',
  traceId: 'tx',
  logger: console as unknown as RouteContext['logger'],
} as unknown as RouteContext

describe('/agents output — peer rendering with kind tags', () => {
  beforeEach(() => {
    // We can't unregister adapters cleanly, but we can register
    // throwaway names that don't collide with the built-ins.
  })

  it('includes [in-process] tag and describe() summary for a native-style adapter', async () => {
    const fake = stubAdapter('test-native-peer-1', 'in-process', ['tnp1'], 'role=cheap -> openai-compat:fake-model')
    registry.registerAgent(fake)
    const out = await handleBuiltInCommand('agents', CTX)
    expect(out).toContain('test-native-peer-1')
    expect(out).toContain('[in-process]')
    expect(out).toContain('/tnp1')
    expect(out).toContain('role=cheap')
    expect(out).toContain('fake-model')
  })

  it('treats kind-less adapters as [cli] for back-compat', async () => {
    const legacy: AgentAdapter = {
      name: 'test-legacy-peer-1',
      aliases: ['tlp1'],
      isAvailable: async () => true,
      async *sendPrompt() { yield '' },
    }
    registry.registerAgent(legacy)
    const out = await handleBuiltInCommand('agents', CTX)
    expect(out).toContain('test-legacy-peer-1')
    expect(out).toContain('[cli]')
  })

  it('renders aliases in slash form, comma-separated', async () => {
    const fake = stubAdapter('test-alias-peer-1', 'cli', ['ap1', 'ap1x', 'aliaspeer'])
    registry.registerAgent(fake)
    const out = await handleBuiltInCommand('agents', CTX)
    expect(out).toContain('(/ap1, /ap1x, /aliaspeer)')
  })

  it('omits summary clause when describe() returns undefined', async () => {
    const fake = stubAdapter('test-nodesc-peer-1', 'cli', ['ndp1'])
    registry.registerAgent(fake)
    const out = await handleBuiltInCommand('agents', CTX)
    // Find the test-nodesc-peer-1 line; it should not contain " — "
    const line = out.split('\n').find((l) => l.includes('test-nodesc-peer-1'))
    expect(line).toBeDefined()
    expect(line).not.toContain(' — ')
  })
})
