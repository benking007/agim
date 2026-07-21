import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_LLM_PRESET,
  getLlmPreset,
  isDeepSeekBaseUrl,
  isKimiBaseUrl,
  isKimiK2Model,
  isKimiK3Model,
  mapVariantToThinkingLevel,
  presetBackendStem,
  presetModels,
  resolveDefaultThinking,
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

  it('ships a built-in Kimi preset (k3 + k2.6) with thinking defaults', () => {
    const kimi = getLlmPreset('moonshot')!
    expect(kimi.label).toBe('Kimi')
    expect(kimi.model).toBe('kimi-k3')
    expect(kimi.cheapModel).toBe('kimi-k2.6')
    expect(presetModels(kimi)).toEqual(['kimi-k3', 'kimi-k2.6'])
    expect(kimi.baseUrl).toBe('https://api.moonshot.cn/v1')
    expect(kimi.defaultThinking).toBe('high')
    expect(presetBackendStem(kimi.baseName, 'kimi-k3', 0)).toBe('kimi-k3')
    expect(presetBackendStem(kimi.baseName, 'kimi-k2.6', 1)).toBe('kimi-k2.6')
  })

  it('detects DeepSeek base URLs', () => {
    expect(isDeepSeekBaseUrl('https://api.deepseek.com')).toBe(true)
    expect(isDeepSeekBaseUrl('https://api.deepseek.com/v1')).toBe(true)
    expect(isDeepSeekBaseUrl('https://api.openai.com/v1')).toBe(false)
  })

  it('detects Kimi / Moonshot base URLs and model families', () => {
    expect(isKimiBaseUrl('https://api.moonshot.cn/v1')).toBe(true)
    expect(isKimiBaseUrl('https://api.moonshot.ai/v1')).toBe(true)
    expect(isKimiBaseUrl('https://api.openai.com/v1')).toBe(false)
    expect(isKimiK3Model('kimi-k3')).toBe(true)
    expect(isKimiK2Model('kimi-k2.6')).toBe(true)
    expect(isKimiK2Model('kimi-k2.7-code-highspeed')).toBe(true)
    expect(isKimiK3Model('kimi-k2.6')).toBe(false)
    expect(resolveDefaultThinking('https://api.moonshot.cn/v1', 'kimi-k3')).toBe('high')
  })

  it('maps /think variants onto pi thinking levels', () => {
    expect(mapVariantToThinkingLevel('', 'high')).toBe('high')
    expect(mapVariantToThinkingLevel('auto', 'high')).toBe('high')
    expect(mapVariantToThinkingLevel('off', 'high')).toBe('off')
    expect(mapVariantToThinkingLevel('max', 'high')).toBe('xhigh')
    expect(mapVariantToThinkingLevel('high', 'off')).toBe('high')
    expect(mapVariantToThinkingLevel('low', 'high')).toBe('low')
  })

  it('suggests unique backend names', () => {
    expect(suggestLlmBackendName('deepseek-agim', [])).toBe('deepseek-agim')
    expect(suggestLlmBackendName('deepseek-agim', ['deepseek-agim'])).toBe('deepseek-agim-2')
  })
})
