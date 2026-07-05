// mcp-approval-server e2e — 端到端串 ApprovalBus ←→ ApprovalClient ←→ McpServer ←→ MCP Client，
// 用 InMemoryTransport 替代 stdio，避免依赖 build / 子进程。

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ApprovalBus, threadKey, type RunContext } from '../../../core/approval-bus.js'
import { ApprovalClient, buildServer } from './mcp-approval-server.js'

const RUN_ID = 'run-test-1'
const RUN_CTX: RunContext = {
  threadId: 'thread-A',
  platform: 'feishu',
  userId: 'u1',
  channelId: 'c1',
}
const KEY = threadKey(RUN_CTX.platform, RUN_CTX.channelId, RUN_CTX.threadId)

function uniqueSocketPath(): string {
  return join(tmpdir(), `agim-mcp-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
}

interface Harness {
  bus: ApprovalBus
  client: ApprovalClient
  mcpClient: Client
  cleanup: () => Promise<void>
}

async function setup(): Promise<Harness> {
  const sockPath = uniqueSocketPath()
  const bus = new ApprovalBus({ approvalTimeoutMs: 500 })
  await bus.start(sockPath)
  bus.registerRun(RUN_ID, RUN_CTX)

  const client = new ApprovalClient(sockPath, RUN_ID)
  const server = buildServer(client)

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)

  const mcpClient = new Client({ name: 'test-client', version: '0.0.0' })
  await mcpClient.connect(clientTransport)

  return {
    bus,
    client,
    mcpClient,
    cleanup: async () => {
      await mcpClient.close()
      await server.close()
      await client.close()
      await bus.stop()
    },
  }
}

describe('mcp-approval-server', () => {
  let h: Harness

  beforeEach(async () => { h = await setup() })
  afterEach(async () => { await h.cleanup() })

  it('exposes a `request` tool', async () => {
    const tools = await h.mcpClient.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain('request')
  })

  it('exposes approval-gated native mutation tools', async () => {
    const tools = await h.mcpClient.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain('agim_bash')
    expect(names).toContain('agim_write')
    expect(names).toContain('agim_edit')
  })

  it('round-trip: tools/call → bus notifier → resolvePending(allow) → MCP result', async () => {
    let captured: { toolName: string; input: Record<string, unknown> } | null = null
    h.bus.setNotifier(async (n) => {
      captured = { toolName: n.toolName, input: n.input }
      // Simulate IM user clicking "approve" by resolving in the next tick
      queueMicrotask(() => {
        h.bus.resolvePending(KEY, { behavior: 'allow' })
      })
    })

    const result = await h.mcpClient.callTool({
      name: 'request',
      arguments: {
        tool_name: 'Bash',
        input: { command: 'git status' },
        tool_use_id: 'tu-1',
      },
    })

    const capturedRequest = captured as { toolName: string; input: Record<string, unknown> } | null
    expect(capturedRequest).not.toBeNull()
    if (!capturedRequest) throw new Error('approval request was not captured')
    expect(capturedRequest.toolName).toBe('Bash')
    expect(capturedRequest.input).toEqual({ command: 'git status' })

    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0].type).toBe('text')
    const decision = JSON.parse(content[0].text)
    // When allow has no explicit updatedInput, sidecar echoes the original
    // input back — Claude Code rejects allow without updatedInput.
    expect(decision.behavior).toBe('allow')
    expect(decision.updatedInput).toEqual({ command: 'git status' })
  })

  it('forwards updatedInput on allow', async () => {
    h.bus.setNotifier(async () => {
      queueMicrotask(() => {
        h.bus.resolvePending(KEY, {
          behavior: 'allow',
          updatedInput: { command: 'echo sandboxed' },
        })
      })
    })

    const result = await h.mcpClient.callTool({
      name: 'request',
      arguments: { tool_name: 'Bash', input: { command: 'echo raw' }, tool_use_id: 'tu' },
    })
    const content = result.content as Array<{ type: string; text: string }>
    const decision = JSON.parse(content[0].text)
    expect(decision.behavior).toBe('allow')
    expect(decision.updatedInput).toEqual({ command: 'echo sandboxed' })
  })

  it('forwards deny + message', async () => {
    h.bus.setNotifier(async () => {
      queueMicrotask(() => {
        h.bus.resolvePending(KEY, { behavior: 'deny', message: '用户拒绝' })
      })
    })

    const result = await h.mcpClient.callTool({
      name: 'request',
      arguments: { tool_name: 'Bash', input: {}, tool_use_id: 'tu' },
    })
    const content = result.content as Array<{ type: string; text: string }>
    const decision = JSON.parse(content[0].text)
    expect(decision).toEqual({ behavior: 'deny', message: '用户拒绝' })
  })

  it('approval timeout (no resolvePending) → MCP returns deny', async () => {
    let notified = false
    h.bus.setNotifier(async () => { notified = true /* never resolve */ })

    const result = await h.mcpClient.callTool({
      name: 'request',
      arguments: { tool_name: 'Bash', input: {}, tool_use_id: 'tu' },
    })
    expect(notified).toBe(true)
    const content = result.content as Array<{ type: string; text: string }>
    const decision = JSON.parse(content[0].text)
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toBe('approval timeout')
  })

  it('also accepts camelCase argument names', async () => {
    let captured: string | null = null
    h.bus.setNotifier(async (n) => {
      captured = n.toolName
      queueMicrotask(() => {
        h.bus.resolvePending(KEY, { behavior: 'allow' })
      })
    })

    // Use a non-readonly tool so the request actually reaches the notifier
    // (Read / Grep / Glob / LS / NotebookRead short-circuit via the readonly
    // auto-allow path and never call the notifier).
    await h.mcpClient.callTool({
      name: 'request',
      arguments: { toolName: 'Edit', input: { file_path: '/etc/hosts' }, toolUseId: 'tu' },
    })
    const capturedTool = captured as string | null
    expect(capturedTool).not.toBeNull()
    expect(capturedTool).toBe('Edit')
  })

  it('agim_bash routes through the bus approval gate before executing', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agim-mcp-native-'))
    h.bus.registerRun(RUN_ID, { ...RUN_CTX, cwd })
    let captured: { toolName: string; input: Record<string, unknown> } | null = null
    h.bus.setNotifier(async (n) => {
      captured = { toolName: n.toolName, input: n.input }
      queueMicrotask(() => {
        h.bus.resolvePending(KEY, { behavior: 'allow' })
      })
    })

    const result = await h.mcpClient.callTool({
      name: 'agim_bash',
      arguments: { command: 'printf agim-ok' },
    })

    const capturedRequest = captured as { toolName: string; input: Record<string, unknown> } | null
    expect(capturedRequest).not.toBeNull()
    if (!capturedRequest) throw new Error('native tool approval was not captured')
    expect(capturedRequest.toolName).toBe('Bash')
    expect(capturedRequest.input).toEqual({ command: 'printf agim-ok' })
    const content = result.content as Array<{ type: string; text: string }>
    const payload = JSON.parse(content[0].text)
    expect(payload.ok).toBe(true)
    expect(String(payload.result)).toContain('agim-ok')
  })

  it('unknown runId is denied immediately', async () => {
    // Build a fresh client whose runId is never registered with the bus
    const sockPath = h.bus.getSocketPath()
    if (!sockPath) throw new Error('bus socket path missing')
    const orphanClient = new ApprovalClient(sockPath, 'never-registered')
    const orphanServer = buildServer(orphanClient)
    const [ct, st] = InMemoryTransport.createLinkedPair()
    await orphanServer.connect(st)
    const orphanMcp = new Client({ name: 'orphan', version: '0.0.0' })
    await orphanMcp.connect(ct)

    h.bus.setNotifier(async () => { throw new Error('notifier should not be called') })

    const result = await orphanMcp.callTool({
      name: 'request',
      arguments: { tool_name: 'Bash', input: {}, tool_use_id: 'tu' },
    })
    const content = result.content as Array<{ type: string; text: string }>
    const decision = JSON.parse(content[0].text)
    expect(decision.behavior).toBe('deny')
    expect(decision.message).toContain('unknown runId')

    await orphanMcp.close()
    await orphanServer.close()
    await orphanClient.close()
  })
})

describe('ApprovalClient (without MCP layer)', () => {
  it('returns deny synchronously when bus socket does not exist', async () => {
    const client = new ApprovalClient('/tmp/agim-nonexistent-socket-xyz', RUN_ID)
    const decision = await client.request({ toolName: 'Bash', input: {}, toolUseId: 'tu' })
    expect(decision.behavior).toBe('deny')
    expect((decision as { message?: string }).message).toContain('approval bus unavailable')
    await client.close()
  })

  it('returns deny on all in-flight requests when bus is stopped mid-call', async () => {
    const sockPath = uniqueSocketPath()
    const bus = new ApprovalBus({ approvalTimeoutMs: 5000 })
    await bus.start(sockPath)
    bus.registerRun(RUN_ID, RUN_CTX)
    bus.setNotifier(async () => { /* never resolve, hold pending */ })

    const client = new ApprovalClient(sockPath, RUN_ID)
    const inFlight = client.request({ toolName: 'Bash', input: {}, toolUseId: 'tu' })

    // Give the request time to land in pending, then stop the bus
    await new Promise((r) => setTimeout(r, 50))
    await bus.stop()

    const decision = await inFlight
    expect(decision.behavior).toBe('deny')
    await client.close()
  })
})
