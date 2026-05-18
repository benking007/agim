// H-N1 — `_im_context` fallback gate.
//
// reminder + memo RPCs accept an agent-asserted `_im_context` payload field
// to identify the IM thread when the opencode HTTP bridge can't carry per-
// spawn env. That fallback is unsafe in multi-tenant deployments because
// the LLM stamps the `userId` itself — a malicious agent can forge another
// user's id to schedule reminders / write memos on their behalf.
//
// IMHUB_RPC_INLINE_CTX_MODE gates the behavior. Default stays
// `single-user` to preserve current opencode-http installs on upgrade;
// multi-tenant operators set it to `off` to force runId-only resolution.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { inlineCtxMode, resolveInlineContext } from '../../src/core/approval-bus'

const ORIGINAL_MODE = process.env.IMHUB_RPC_INLINE_CTX_MODE

afterEach(() => {
  if (ORIGINAL_MODE === undefined) delete process.env.IMHUB_RPC_INLINE_CTX_MODE
  else process.env.IMHUB_RPC_INLINE_CTX_MODE = ORIGINAL_MODE
})

describe('inlineCtxMode', () => {
  beforeEach(() => { delete process.env.IMHUB_RPC_INLINE_CTX_MODE })

  it('defaults to single-user when env unset', () => {
    expect(inlineCtxMode()).toBe('single-user')
  })

  it('off|0|false → off', () => {
    process.env.IMHUB_RPC_INLINE_CTX_MODE = 'off';        expect(inlineCtxMode()).toBe('off')
    process.env.IMHUB_RPC_INLINE_CTX_MODE = '0';          expect(inlineCtxMode()).toBe('off')
    process.env.IMHUB_RPC_INLINE_CTX_MODE = 'false';      expect(inlineCtxMode()).toBe('off')
    process.env.IMHUB_RPC_INLINE_CTX_MODE = 'OFF';        expect(inlineCtxMode()).toBe('off')
  })

  it('anything else → single-user (permissive fallback)', () => {
    process.env.IMHUB_RPC_INLINE_CTX_MODE = 'single-user'; expect(inlineCtxMode()).toBe('single-user')
    process.env.IMHUB_RPC_INLINE_CTX_MODE = 'yolo';        expect(inlineCtxMode()).toBe('single-user')
    process.env.IMHUB_RPC_INLINE_CTX_MODE = '';            expect(inlineCtxMode()).toBe('single-user')
  })
})

describe('resolveInlineContext', () => {
  beforeEach(() => { delete process.env.IMHUB_RPC_INLINE_CTX_MODE })

  it('returns null when mode=off (gate closed)', () => {
    process.env.IMHUB_RPC_INLINE_CTX_MODE = 'off'
    const payload: Record<string, unknown> = {
      _im_context: { platform: 'telegram', threadId: 't1', channelId: 'c1', userId: 'u1' },
    }
    expect(resolveInlineContext(payload)).toBeNull()
    // Payload preserved so caller can detect "gate closed AND payload had it"
    // and report a clearer error than "unknown runId".
    expect(payload._im_context).toBeDefined()
  })

  it('returns ctx when mode=single-user and payload valid', () => {
    const payload: Record<string, unknown> = {
      other: 'keep me',
      _im_context: { platform: 'telegram', threadId: 't1', channelId: 'c1', userId: 'u1' },
    }
    const ctx = resolveInlineContext(payload)
    expect(ctx).toEqual({ platform: 'telegram', threadId: 't1', channelId: 'c1', userId: 'u1' })
    // _im_context stripped so downstream RPC field validators don't trip
    expect(payload._im_context).toBeUndefined()
    // Other payload fields untouched
    expect(payload.other).toBe('keep me')
  })

  it('returns null when payload field absent', () => {
    expect(resolveInlineContext({})).toBeNull()
  })

  it('returns null when payload field is null / array / scalar', () => {
    expect(resolveInlineContext({ _im_context: null })).toBeNull()
    expect(resolveInlineContext({ _im_context: 'string' })).toBeNull()
    expect(resolveInlineContext({ _im_context: [1, 2, 3] })).toBeNull()
    expect(resolveInlineContext({ _im_context: 42 })).toBeNull()
  })

  it('returns null when required keys missing', () => {
    expect(resolveInlineContext({ _im_context: { platform: 'tg' } })).toBeNull()
    expect(resolveInlineContext({ _im_context: { platform: 'tg', threadId: 't' } })).toBeNull()
    expect(resolveInlineContext({ _im_context: { threadId: 't', channelId: 'c' } })).toBeNull()
  })

  it('returns null when required keys are wrong type', () => {
    expect(resolveInlineContext({
      _im_context: { platform: 123, threadId: 't', channelId: 'c' },
    })).toBeNull()
  })

  it('coerces missing userId to empty string (legacy compat)', () => {
    const ctx = resolveInlineContext({
      _im_context: { platform: 'wechat', threadId: 't', channelId: 'c' },
    })
    expect(ctx).not.toBeNull()
    expect(ctx?.userId).toBe('')
  })

  it('ignores agent-supplied userId of wrong type', () => {
    const ctx = resolveInlineContext({
      _im_context: { platform: 'wechat', threadId: 't', channelId: 'c', userId: { evil: 'object' } },
    })
    expect(ctx).not.toBeNull()
    expect(ctx?.userId).toBe('')
  })
})
