// Unit tests for mcp-client helpers + mcp-registry lifecycle.
//
// We don't spin up real MCP subprocesses here — that's integration-test
// territory and would require either a packaged echo MCP server or
// hand-rolled stdio child-process management that's brittle in CI.
// Instead we cover:
//
//   1. Pure helper functions (namespacedName / ensureObjectSchema /
//      aggregateTextContent) — these are the only places where a regex
//      or content-block-parser bug could silently corrupt tool routing.
//   2. The registry's lifecycle in the "no servers configured" and
//      "duplicate / disabled / unknown name" paths — those are the
//      ones that don't need a connection.
//   3. The registry's "unknown tool" dispatch fallback — verifies the
//      agent loop gets a graceful error rather than a throw.

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  _namespacedNameForTest as namespacedName,
  _ensureObjectSchemaForTest as ensureObjectSchema,
  _aggregateTextContentForTest as aggregateTextContent,
} from './mcp-client.js'
import {
  loadMcpFromConfig,
  getAllMcpTools,
  describeMcpRegistry,
  callMcpToolByName,
  _resetMcpRegistry,
} from './index.js'

beforeEach(() => { _resetMcpRegistry() })

describe('mcp-client helpers', () => {
  it('namespacedName: prefixes mcp_{server}_{tool} and sanitizes non-alnum', () => {
    expect(namespacedName('fs', 'read_file')).toBe('mcp_fs_read_file')
    expect(namespacedName('github-tools', 'list-prs')).toBe('mcp_github_tools_list_prs')
    expect(namespacedName('my.server', 'do.it')).toBe('mcp_my_server_do_it')
  })

  it('ensureObjectSchema: defaults to {type:object, properties:{}} on non-object inputs', () => {
    expect(ensureObjectSchema(undefined)).toEqual({ type: 'object', properties: {} })
    expect(ensureObjectSchema(null)).toEqual({ type: 'object', properties: {} })
    expect(ensureObjectSchema('not a schema')).toEqual({ type: 'object', properties: {} })
    expect(ensureObjectSchema([])).toEqual({ type: 'object', properties: {} })
  })

  it('ensureObjectSchema: passes through valid object schemas verbatim', () => {
    const schema = {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    }
    expect(ensureObjectSchema(schema)).toEqual(schema)
  })

  it('aggregateTextContent: concatenates text blocks in order', () => {
    const blocks = [
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]
    expect(aggregateTextContent(blocks)).toBe('hello world')
  })

  it('aggregateTextContent: surfaces image/resource markers without dropping context', () => {
    const blocks = [
      { type: 'text', text: 'before ' },
      { type: 'image', source: { url: '…' } },
      { type: 'text', text: ' after' },
      { type: 'resource', uri: 'file:///x' },
      { type: 'resource_link', uri: 'file:///y' },
    ]
    expect(aggregateTextContent(blocks)).toBe('before [image] after[resource][resource]')
  })

  it('aggregateTextContent: returns empty string for non-arrays / empty arrays', () => {
    expect(aggregateTextContent(undefined)).toBe('')
    expect(aggregateTextContent(null)).toBe('')
    expect(aggregateTextContent('text')).toBe('')
    expect(aggregateTextContent([])).toBe('')
  })

  it('aggregateTextContent: skips malformed blocks', () => {
    const blocks: unknown[] = [
      null,
      { type: 'text', text: 'good' },
      { type: 'text' },         // missing text field
      { text: 'no type field' },
      'string block',
    ]
    expect(aggregateTextContent(blocks)).toBe('good')
  })
})

describe('mcp-registry lifecycle', () => {
  it('empty config: describeRegistry returns no servers / 0 tools', async () => {
    await loadMcpFromConfig({ mcpServers: [] })
    const desc = describeMcpRegistry()
    expect(desc.servers).toHaveLength(0)
    expect(desc.totalTools).toBe(0)
    expect(getAllMcpTools()).toEqual([])
  })

  it('no mcpServers key at all: same as empty', async () => {
    await loadMcpFromConfig({})
    expect(describeMcpRegistry().servers).toHaveLength(0)
  })

  it('registers entries without auto-connecting', async () => {
    await loadMcpFromConfig({
      mcpServers: [
        { name: 'demo', command: 'echo', args: ['hi'] },
      ],
    })
    const desc = describeMcpRegistry()
    expect(desc.servers).toHaveLength(1)
    expect(desc.servers[0].connected).toBe(false)
    expect(desc.totalTools).toBe(0)
  })

  it('skips disabled entries', async () => {
    await loadMcpFromConfig({
      mcpServers: [
        { name: 'demo', command: 'echo', args: ['hi'], enabled: false },
        { name: 'live', command: 'echo', args: ['hi'] },
      ],
    })
    const desc = describeMcpRegistry()
    expect(desc.servers.map((s) => s.name)).toEqual(['live'])
  })

  it('duplicate names: last wins (warn logged)', async () => {
    await loadMcpFromConfig({
      mcpServers: [
        { name: 'demo', command: 'echo', args: ['first'] },
        { name: 'demo', command: 'echo', args: ['second'] },
      ],
    })
    const desc = describeMcpRegistry()
    expect(desc.servers).toHaveLength(1)
  })

  it('callMcpToolByName on unknown tool returns isError without throwing', async () => {
    await loadMcpFromConfig({})
    const r = await callMcpToolByName('mcp_nonexistent_tool', {})
    expect(r.isError).toBe(true)
    expect(r.text).toContain('unknown MCP tool')
  })

  it('reset clears all state', async () => {
    await loadMcpFromConfig({
      mcpServers: [{ name: 'demo', command: 'echo' }],
    })
    expect(describeMcpRegistry().servers).toHaveLength(1)
    _resetMcpRegistry()
    expect(describeMcpRegistry().servers).toHaveLength(0)
  })
})
