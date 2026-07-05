import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleNativeToolOp, normalizeNativeToolName } from './native-tool-rpc.js'

const NEVER_ABORT = new AbortController().signal
const RUN_CTX = {
  threadId: 'thread-A',
  platform: 'web',
  userId: 'user-1',
  channelId: 'chan-1',
  callerAgent: 'pi',
}

describe('native-tool-rpc', () => {
  it('maps public PI aliases to native read-only web tools', () => {
    expect(normalizeNativeToolName('web_search')).toBe('native_web_search')
    expect(normalizeNativeToolName('web_fetch')).toBe('native_web_fetch')
    expect(normalizeNativeToolName('native_web_search')).toBe('native_web_search')
    expect(normalizeNativeToolName('native_web_fetch')).toBe('native_web_fetch')
    expect(normalizeNativeToolName('agim_bash')).toBe('native_exec')
    expect(normalizeNativeToolName('agim_write')).toBe('native_write_file')
    expect(normalizeNativeToolName('agim_edit')).toBe('native_edit_file')
  })

  it('does not expose high-risk native tools', async () => {
    expect(normalizeNativeToolName('native_exec')).toBeNull()
    const res = await handleNativeToolOp(
      { name: 'native_exec', arguments: { command: 'pwd' } },
      { reqId: 'test', signal: NEVER_ABORT },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('native tool not exposed')
  })

  it('dispatches web_fetch through the native web dispatcher', async () => {
    const res = await handleNativeToolOp(
      { name: 'web_fetch', arguments: { url: 'http://192.168.1.1/' } },
      { reqId: 'test', signal: NEVER_ABORT },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/RFC1918|private/i)
    expect(res.source).toBe('web')
  })

  it('requires approval for mutation aliases', async () => {
    const res = await handleNativeToolOp(
      { name: 'agim_bash', arguments: { command: 'printf hi' } },
      { reqId: 'test', signal: NEVER_ABORT, runContext: RUN_CTX },
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toContain('requires approval')
  })

  it('does not execute a denied bash request', async () => {
    const res = await handleNativeToolOp(
      { name: 'agim_bash', arguments: { command: 'printf hi' } },
      {
        reqId: 'test',
        signal: NEVER_ABORT,
        runContext: RUN_CTX,
        requestApproval: async ({ toolName, input }) => {
          expect(toolName).toBe('Bash')
          expect(input.command).toBe('printf hi')
          return { behavior: 'deny', message: 'nope' }
        },
      },
    )
    expect(res).toEqual({ ok: false, error: 'nope' })
  })

  it('executes bash after approval', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agim-native-rpc-'))
    const res = await handleNativeToolOp(
      { name: 'agim_bash', arguments: { command: 'printf hi' } },
      {
        reqId: 'test',
        signal: NEVER_ABORT,
        runContext: { ...RUN_CTX, cwd },
        requestApproval: async () => ({ behavior: 'allow' }),
      },
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.result).toContain('"stdout": "hi"')
    expect(res.source).toBe('exec')
  })

  it('writes files after approval', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agim-native-rpc-'))
    const res = await handleNativeToolOp(
      { name: 'agim_write', arguments: { path: 'out.txt', content: 'hello' } },
      {
        reqId: 'test',
        signal: NEVER_ABORT,
        runContext: { ...RUN_CTX, cwd },
        requestApproval: async ({ toolName, input }) => {
          expect(toolName).toBe('Write')
          expect(input.file_path).toBe('out.txt')
          return { behavior: 'allow' }
        },
      },
    )
    expect(res.ok).toBe(true)
    expect(await readFile(join(cwd, 'out.txt'), 'utf8')).toBe('hello')
  })

  it('edits files after approval', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agim-native-rpc-'))
    await handleNativeToolOp(
      { name: 'agim_write', arguments: { path: 'edit.txt', content: 'hello old' } },
      {
        reqId: 'seed',
        signal: NEVER_ABORT,
        runContext: { ...RUN_CTX, cwd },
        requestApproval: async () => ({ behavior: 'allow' }),
      },
    )

    const res = await handleNativeToolOp(
      { name: 'agim_edit', arguments: { path: 'edit.txt', old_string: 'old', new_string: 'new' } },
      {
        reqId: 'test',
        signal: NEVER_ABORT,
        runContext: { ...RUN_CTX, cwd },
        requestApproval: async ({ toolName, input }) => {
          expect(toolName).toBe('Edit')
          expect(input.file_path).toBe('edit.txt')
          return { behavior: 'allow' }
        },
      },
    )
    expect(res.ok).toBe(true)
    expect(await readFile(join(cwd, 'edit.txt'), 'utf8')).toBe('hello new')
  })
})
