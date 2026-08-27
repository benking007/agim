import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  applyVisionResultToPrompt,
  isDedicatedVisionModel,
  runVisionRoute,
  shouldRouteVision,
  stripImageContentBlocks,
  VISION_ROUTE_RESULT_END,
  VISION_ROUTE_RESULT_START,
} from './vision-route.js'

const root = mkdtempSync(join(tmpdir(), 'agim-vision-route-'))
const mediaDir = join(root, 'media')
const imagePath = join(mediaDir, 'web', 'shot.png')

beforeAll(() => {
  mkdirSync(join(mediaDir, 'web'), { recursive: true })
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  process.env.AGIM_MEDIA_ROOT = mediaDir
})

afterAll(() => {
  delete process.env.AGIM_MEDIA_ROOT
  delete process.env.AGIM_VISION_ROUTE
  try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
})

const pictured = `请看这张图 [图片附件：${imagePath}]`

describe('vision-route gating', () => {
  it('routes a text SKU when the current prompt has a media marker', () => {
    expect(shouldRouteVision('deepseek-v4-pro', pictured)).toBe(true)
    expect(shouldRouteVision('deepseek-v4-flash', pictured)).toBe(true)
  })

  it('does not route the dedicated vision SKU (child receives image bytes)', () => {
    expect(isDedicatedVisionModel('deepseek-v4-flash-vision-exp')).toBe(true)
    expect(shouldRouteVision('deepseek-v4-flash-vision-exp', pictured)).toBe(false)
  })

  it('does not route a text-only prompt', () => {
    expect(shouldRouteVision('deepseek-v4-pro', 'hello')).toBe(false)
  })

  it('does not route when AGIM_VISION_ROUTE=off', () => {
    process.env.AGIM_VISION_ROUTE = 'off'
    expect(shouldRouteVision('deepseek-v4-pro', pictured)).toBe(false)
    delete process.env.AGIM_VISION_ROUTE
  })

  it('does not route a prompt that already carries a vision result', () => {
    const once = applyVisionResultToPrompt(pictured, 'a red button')
    expect(shouldRouteVision('deepseek-v4-pro', once)).toBe(false)
  })
})

describe('vision-route injection', () => {
  it('appends the child analysis onto the parent prompt', () => {
    const next = applyVisionResultToPrompt('看图', '按钮是红色的')
    expect(next).toContain('看图')
    expect(next).toContain(VISION_ROUTE_RESULT_START)
    expect(next).toContain('按钮是红色的')
    expect(next).toContain(VISION_ROUTE_RESULT_END)
  })

  it('strips historical image blocks from parent context', () => {
    const messages = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image', data: 'abc', mimeType: 'image/png' },
        ],
      },
    ]
    const stripped = stripImageContentBlocks(messages)
    expect(stripped[0]?.content).toEqual([{ type: 'text', text: 'see this' }])
  })
})

describe('runVisionRoute', () => {
  it('spawns backend=vision and folds the child result into the parent prompt', async () => {
    const calls: Array<{ agent: string; prompt: string; model?: string }> = []
    const routed = await runVisionRoute(
      { prompt: pictured, modelId: 'deepseek-v4-pro', callerAgent: 'agim' },
      {
        resolveSpawn: () => ({
          ok: true,
          agent: 'agim',
          model: 'deepseek-v4-flash-vision-exp',
          isolate: true,
          sameAgent: true,
          label: 'agim:deepseek-v4-flash-vision-exp',
        }),
        callAgent: async (agent, prompt, _ctx, opts) => {
          calls.push({ agent, prompt, model: opts?.model })
          return {
            ok: true,
            result: '## OCR text\nOK\n## Description\nA screenshot.',
            jobId: 9,
            agent,
            durationMs: 12,
            artifactsDir: '/tmp',
            outputs: [],
          }
        },
      },
    )
    expect(routed.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.agent).toBe('agim')
    expect(calls[0]?.model).toBe('deepseek-v4-flash-vision-exp')
    expect(calls[0]?.prompt).toContain(`[图片附件：${imagePath}]`)
    expect(calls[0]?.prompt).toContain('do not call call_agent')
    expect(routed.parentPrompt).toContain(pictured)
    expect(routed.parentPrompt).toContain('A screenshot.')
    expect(routed.parentPrompt).toContain(VISION_ROUTE_RESULT_START)
  })

  it('still hands a failure note to the parent when spawn cannot resolve', async () => {
    const routed = await runVisionRoute(
      { prompt: pictured, modelId: 'deepseek-v4-pro', callerAgent: 'agim' },
      {
        resolveSpawn: () => ({ ok: false, error: 'backend "vision" not found' }),
        callAgent: async () => {
          throw new Error('should not spawn')
        },
      },
    )
    expect(routed.ok).toBe(false)
    expect(routed.parentPrompt).toContain(VISION_ROUTE_RESULT_START)
    expect(routed.parentPrompt).toContain('backend "vision" not found')
    expect(routed.parentPrompt).toContain(pictured)
  })
})
