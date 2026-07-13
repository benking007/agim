import { describe, expect, it } from 'bun:test'
import { ACPAdapter } from './acp-adapter.js'
import type { ACPClient } from './acp-client.js'

function adapterWithClient(client: Partial<ACPClient>): ACPAdapter {
  const adapter = new ACPAdapter({
    name: 'acp-test',
    endpoint: 'http://127.0.0.1:9',
    aliases: [],
  })
  ;(adapter as unknown as { client: ACPClient }).client = client as ACPClient
  return adapter
}

async function collect(gen: AsyncGenerator<string>): Promise<string> {
  let out = ''
  for await (const chunk of gen) out += chunk
  return out
}

describe('ACPAdapter turn contract', () => {
  it('reports aborted outcome when signal is already aborted', async () => {
    const adapter = adapterWithClient({
      streamPrompt: async function* () { yield 'should-not-run' },
    })
    const ctrl = new AbortController()
    ctrl.abort()
    let outcome: string | undefined
    const out = await collect(adapter.sendPrompt('s1', 'hi', undefined, {
      signal: ctrl.signal,
      onOutcome: (value) => { outcome = value.status },
    }))
    expect(out).toBe('')
    expect(outcome).toBe('aborted')
  })

  it('forwards signal into streamPrompt and reports success', async () => {
    let seenSignal: AbortSignal | undefined
    const adapter = adapterWithClient({
      streamPrompt: async function* (_p, _h, _s, signal) {
        seenSignal = signal
        yield 'ok'
      },
    })
    const ctrl = new AbortController()
    let outcome: string | undefined
    const out = await collect(adapter.sendPrompt('s1', 'hi', undefined, {
      signal: ctrl.signal,
      onOutcome: (value) => { outcome = value.status },
    }))
    expect(out).toBe('ok')
    expect(seenSignal).toBe(ctrl.signal)
    expect(outcome).toBe('success')
  })

  it('reports aborted when stream throws AbortError', async () => {
    const adapter = adapterWithClient({
      // biome-ignore lint/correctness/useYield: aborting stub never yields
      streamPrompt: async function* () {
        const err = new Error('aborted')
        err.name = 'AbortError'
        throw err
      },
    })
    let outcome: string | undefined
    const out = await collect(adapter.sendPrompt('s1', 'hi', undefined, {
      onOutcome: (value) => { outcome = value.status },
    }))
    expect(out).toBe('')
    expect(outcome).toBe('aborted')
  })
})
