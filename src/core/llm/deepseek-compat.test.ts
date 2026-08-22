import { describe, expect, it } from 'bun:test'
import {
  DEEPSEEK_ANTHROPIC_BASE,
  DEEPSEEK_BETA_BASE,
  DEEPSEEK_THINKING_LEVEL_MAP,
  applyDeepSeekVisionModel,
  applyStrictToolsToOpenAiPayload,
  hashDeepSeekUserId,
  isDeepSeekAnthropicBaseUrl,
  normalizeDeepSeekAnthropicThinkingPayload,
  normalizeJsonSchemaForStrict,
  resolveDeepSeekOpenAiBaseUrl,
  withDeepSeekAnthropicUserId,
  withDeepSeekUserId,
} from './deepseek-compat.js'

describe('deepseek-compat', () => {
  it('maps Agim thinking chips onto official V4 efforts', () => {
    expect(DEEPSEEK_THINKING_LEVEL_MAP.minimal).toBeNull()
    expect(DEEPSEEK_THINKING_LEVEL_MAP.low).toBe('low')
    expect(DEEPSEEK_THINKING_LEVEL_MAP.medium).toBe('high')
    expect(DEEPSEEK_THINKING_LEVEL_MAP.high).toBe('high')
    expect(DEEPSEEK_THINKING_LEVEL_MAP.xhigh).toBe('max')
  })

  it('hashes platform:userId into a safe DeepSeek user_id', () => {
    const a = hashDeepSeekUserId('web', 'alice')
    const b = hashDeepSeekUserId('web', 'alice')
    const c = hashDeepSeekUserId('telegram', 'alice')
    expect(a).toBe(b)
    expect(a).toMatch(/^agim-[a-f0-9]{32}$/)
    expect(a).not.toBe(c)
    expect(hashDeepSeekUserId('', '')).toBeUndefined()
    expect(hashDeepSeekUserId(undefined, undefined)).toBeUndefined()
  })

  it('injects user_id only when missing (OpenAI + Anthropic shapes)', () => {
    expect(withDeepSeekUserId({ model: 'deepseek-v4-pro' }, 'agim-abc')).toEqual({
      model: 'deepseek-v4-pro',
      user_id: 'agim-abc',
    })
    expect(withDeepSeekUserId({ user_id: 'keep-me' }, 'agim-abc')).toEqual({
      user_id: 'keep-me',
    })
    expect(withDeepSeekAnthropicUserId({ model: 'x' }, 'agim-abc')).toEqual({
      model: 'x',
      metadata: { user_id: 'agim-abc' },
    })
    expect(withDeepSeekAnthropicUserId({ metadata: { user_id: 'keep' } }, 'agim-abc')).toEqual({
      metadata: { user_id: 'keep' },
    })
  })

  it('detects Anthropic DeepSeek base and beta chat base', () => {
    expect(isDeepSeekAnthropicBaseUrl(DEEPSEEK_ANTHROPIC_BASE)).toBe(true)
    expect(isDeepSeekAnthropicBaseUrl('https://api.deepseek.com')).toBe(false)
    expect(resolveDeepSeekOpenAiBaseUrl({ strictTools: true })).toBe(DEEPSEEK_BETA_BASE)
    expect(resolveDeepSeekOpenAiBaseUrl({ beta: true })).toBe(DEEPSEEK_BETA_BASE)
  })

  it('normalizes JSON Schema for DeepSeek strict tools', () => {
    const normalized = normalizeJsonSchemaForStrict({
      type: 'object',
      properties: {
        decision: { type: 'string' },
        gaps: { type: 'array', items: { type: 'string' }, minItems: 0, maxItems: 8 },
        optionalNote: { type: 'string', minLength: 1 },
      },
      required: ['decision'],
    })
    expect(normalized.additionalProperties).toBe(false)
    expect(normalized.required).toEqual(['decision', 'gaps', 'optionalNote'])
    const gaps = normalized.properties as Record<string, Record<string, unknown>>
    expect(gaps.gaps?.minItems).toBeUndefined()
    expect(gaps.gaps?.maxItems).toBeUndefined()
    expect(gaps.optionalNote?.minLength).toBeUndefined()
  })

  it('applies strict:true + normalized parameters on OpenAI tools payload', () => {
    const out = applyStrictToolsToOpenAiPayload({
      tools: [{
        type: 'function',
        function: {
          name: 'loop_verdict',
          parameters: {
            type: 'object',
            properties: { decision: { type: 'string' }, met: { type: 'boolean' } },
            required: ['decision'],
          },
        },
      }],
    })
    const fn = (out.tools as Array<{ function: Record<string, unknown> }>)[0]!.function
    expect(fn.strict).toBe(true)
    expect((fn.parameters as { required: string[] }).required).toEqual(['decision', 'met'])
  })

  it('routes DeepSeek text SKUs onto the vision model when images are present', () => {
    const pro = {
      id: 'deepseek-v4-pro',
      name: 'deepseek-v4-pro',
      baseUrl: 'https://api.deepseek.com',
      input: ['text'] as Array<'text' | 'image'>,
    }
    expect(applyDeepSeekVisionModel(pro, false)).toEqual(pro)
    const routed = applyDeepSeekVisionModel(pro, true)
    expect(routed.id).toBe('deepseek-v4-flash-vision-exp')
    expect(routed.name).toBe('deepseek-v4-flash-vision-exp')
    expect(routed.input).toEqual(['text', 'image'])
    expect(routed.baseUrl).toBe('https://api.deepseek.com')

    const kimi = {
      id: 'kimi-k3',
      name: 'kimi-k3',
      baseUrl: 'https://api.moonshot.cn/v1',
      input: ['text', 'image'] as Array<'text' | 'image'>,
    }
    expect(applyDeepSeekVisionModel(kimi, true)).toEqual(kimi)

    const already = {
      id: 'deepseek-v4-flash-vision-exp',
      name: 'deepseek-v4-flash-vision-exp',
      baseUrl: 'https://api.deepseek.com',
      input: ['text', 'image'] as Array<'text' | 'image'>,
    }
    expect(applyDeepSeekVisionModel(already, true)).toBe(already)
  })

  it('rewrites Anthropic thinking to enabled + output_config.effort', () => {
    const out = normalizeDeepSeekAnthropicThinkingPayload({
      thinking: { type: 'enabled', budget_tokens: 2048, display: 'summarized' },
    }, 'high')
    expect(out.thinking).toEqual({ type: 'enabled' })
    expect(out.output_config).toEqual({ effort: 'high' })
  })
})
