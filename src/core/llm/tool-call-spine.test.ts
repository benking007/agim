import { afterEach, describe, expect, it } from 'bun:test'
import {
  dispatchToolWithTimeout,
  prevalidateToolArgs,
  ZH_TOOL_TIMEOUT_MESSAGES,
} from './tool-call-spine.js'

describe('tool-call-spine', () => {
  const prev = process.env.AGIM_TOOL_SCHEMA_VALIDATE
  afterEach(() => {
    if (prev === undefined) delete process.env.AGIM_TOOL_SCHEMA_VALIDATE
    else process.env.AGIM_TOOL_SCHEMA_VALIDATE = prev
  })

  it('prevalidateToolArgs refuses missing required fields', () => {
    const r = prevalidateToolArgs('agim_read_file', {}, {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toMatch(/validation failed/)
  })

  it('prevalidateToolArgs can be disabled', () => {
    process.env.AGIM_TOOL_SCHEMA_VALIDATE = 'off'
    const r = prevalidateToolArgs('agim_read_file', {}, {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    })
    expect(r.ok).toBe(true)
  })

  it('read-only timeout rejects immediately (detachOnAbort)', async () => {
    const run = (sig: AbortSignal) => new Promise<{ text: string; isError: boolean }>((resolve) => {
      sig.addEventListener('abort', () => resolve({ text: 'aborted', isError: true }), { once: true })
    })
    await expect(dispatchToolWithTimeout(
      run,
      new AbortController().signal,
      20,
      'agim_read_file',
      { detachOnAbort: true, messages: ZH_TOOL_TIMEOUT_MESSAGES },
    )).rejects.toThrow(/超时/)
  })

  it('mutations wait for settle after timeout abort', async () => {
    let settled = false
    const run = (sig: AbortSignal) => new Promise<{ text: string; isError: boolean }>((resolve) => {
      sig.addEventListener('abort', () => {
        setTimeout(() => {
          settled = true
          resolve({ text: 'cleaned up', isError: true })
        }, 30)
      }, { once: true })
    })
    const r = await dispatchToolWithTimeout(
      run,
      new AbortController().signal,
      15,
      'agim_write_file',
      { detachOnAbort: false, messages: ZH_TOOL_TIMEOUT_MESSAGES },
    )
    expect(settled).toBe(true)
    expect(r.isError).toBe(true)
    expect(r.source).toBe('timeout')
    expect(r.text).toMatch(/超时并已停止/)
  })
})
