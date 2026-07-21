import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_LLM_PRESET,
  isDeepSeekBaseUrl,
  mapVariantToThinkingLevel,
  presetBackendStem,
  presetModels,
  suggestLlmBackendName,
} from './presets.js'

describe('llm presets', () => {
  it('defaults Agim Agent preset to DeepSeek v4 pro + flash', () => {
    expect(DEFAULT_LLM_PRESET.key).toBe('deepseek')
    expect(DEFAULT_LLM_PRESET.model).toBe('deepseek-v4-pro')
    expect(DEFAULT_LLM_PRESET.cheapModel).toBe('deepseek-v4-flash')
    expect(presetModels(DEFAULT_LLM_PRESET)).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])
    expect(presetBackendStem('deepseek-agim', 'deepseek-v4-pro', 0)).toBe('deepseek-v4-pro')
    expect(presetBackendStem('deepseek-agim', 'deepseek-v4-flash', 1)).toBe('deepseek-v4-flash')
    expect(DEFAULT_LLM_PRESET.baseUrl).toBe('https://api.deepseek.com')
  })

  it('detects DeepSeek base URLs', () => {
    expect(isDeepSeekBaseUrl('https://api.deepseek.com')).toBe(true)
    expect(isDeepSeekBaseUrl('https://api.deepseek.com/v1')).toBe(true)
    expect(isDeepSeekBaseUrl('https://api.openai.com/v1')).toBe(false)
  })

  it('maps /think variants onto pi thinking levels', () => {
    expect(mapVariantToThinkingLevel('', 'high')).toBe('high')
    expect(mapVariantToThinkingLevel('auto', 'high')).toBe('high')
    expect(mapVariantToThinkingLevel('off', 'high')).toBe('off')
    expect(mapVariantToThinkingLevel('max', 'high')).toBe('xhigh')
    expect(mapVariantToThinkingLevel('high', 'off')).toBe('high')
  })

  it('suggests unique backend names', () => {
    expect(suggestLlmBackendName('deepseek-agim', [])).toBe('deepseek-agim')
    expect(suggestLlmBackendName('deepseek-agim', ['deepseek-agim'])).toBe('deepseek-agim-2')
  })
})
