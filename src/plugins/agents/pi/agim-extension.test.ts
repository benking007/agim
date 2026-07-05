import { describe, expect, it } from 'bun:test'
import agimPiExtension from './agim-extension.js'

type PiApi = Parameters<typeof agimPiExtension>[0]
type PiTool = Parameters<PiApi['registerTool']>[0]

describe('PI Agim extension', () => {
  it('registers Agim RPC tools plus read-only native web aliases', () => {
    const tools: PiTool[] = []
    agimPiExtension({
      registerTool(tool) {
        tools.push(tool)
      },
    })

    const names = tools.map((tool) => tool.name)
    expect(names).toContain('web_search')
    expect(names).toContain('web_fetch')
    expect(names).toContain('agim_bash')
    expect(names).toContain('agim_write')
    expect(names).toContain('agim_edit')
    expect(names).toContain('mcp__agim__memory_query')
    expect(names).toContain('mcp__agim__call_agent')
    expect(names).not.toContain('native_exec')
    expect(names).not.toContain('bash')
    expect(names).not.toContain('write')
    expect(names).not.toContain('edit')
  })

  it('uses tight schemas for web aliases', () => {
    const tools: PiTool[] = []
    agimPiExtension({ registerTool: (tool) => { tools.push(tool) } })

    const search = tools.find((tool) => tool.name === 'web_search')
    const fetch = tools.find((tool) => tool.name === 'web_fetch')
    expect(search?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['query'],
    })
    expect(fetch?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['url'],
    })
  })

  it('uses tight schemas for approval-gated mutation aliases', () => {
    const tools: PiTool[] = []
    agimPiExtension({ registerTool: (tool) => { tools.push(tool) } })

    expect(tools.find((tool) => tool.name === 'agim_bash')?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['command'],
    })
    expect(tools.find((tool) => tool.name === 'agim_write')?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['path', 'content'],
    })
    expect(tools.find((tool) => tool.name === 'agim_edit')?.parameters).toMatchObject({
      additionalProperties: false,
      required: ['path', 'old_string', 'new_string'],
    })
  })
})
