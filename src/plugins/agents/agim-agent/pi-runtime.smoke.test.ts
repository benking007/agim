// Runtime smoke for the Agim Agent pi-agent-core foundation. Proves the PUBLISHED
// npm packages (@earendil-works/pi-agent-core + pi-ai) work end-to-end under
// agim's own runtime — not just typecheck — through their PUBLIC API only:
//   - AgentHarness + a tool (agim tools wrap as plain JSON Schema; pi accepts it)
//   - JsonlSessionRepo for durable, per-session persistence (the public durable
//     entry — JsonlSessionStorage itself is not in the package exports map)
//   - faux provider for deterministic, offline execution
//
// This is the de-risk gate before building the real Agim Agent adapter.
// It registers nothing and touches no live path.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHarness, JsonlSessionRepo } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from '@earendil-works/pi-ai'
import { describe, expect, it } from 'bun:test'

describe('Agim Agent runtime foundation (published npm packages)', () => {
  it('runs a faux tool turn and persists it durably via JsonlSessionRepo', async () => {
    const reg = registerFauxProvider()
    try {
      reg.setResponses([
        fauxAssistantMessage(fauxToolCall('echo', { text: 'durable-hi' }, { id: 'c1' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage('done'),
      ])

      const root = mkdtempSync(join(tmpdir(), 'agim-pi-smoke-'))
      const env = new NodeExecutionEnv({ cwd: root })
      const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root })
      const session = await repo.create({ cwd: root })

      const sink: string[] = []
      // agim-style tool authored as plain JSON Schema (no TypeBox needed).
      const echoTool = {
        label: 'Echo',
        name: 'echo',
        description: 'echo text',
        // biome-ignore lint/suspicious/noExplicitAny: pi reads only .properties/.required off this
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } as any,
        execute: async (_id: string, args: unknown) => {
          const text = (args as { text: string }).text
          sink.push(text)
          return { content: [{ type: 'text' as const, text: `echoed:${text}` }], details: undefined }
        },
      }

      const harness = new AgentHarness({ env, session, model: reg.getModel(), tools: [echoTool] })
      await harness.prompt('please echo')
      expect(sink).toEqual(['durable-hi']) // tool actually executed in-process

      // Durable reopen: a fresh Session from disk sees the persisted turn.
      const metas = await repo.list()
      expect(metas.length).toBe(1)
      const reopened = await repo.open(metas[0]!)
      const entries = await reopened.getEntries()
      expect(JSON.stringify(entries)).toContain('durable-hi') // mid-run turn survived to disk
    } finally {
      reg.unregister()
    }
  })
})
