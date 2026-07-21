import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_LLM_PRESET,
  builtinPresetKeyForBaseUrl,
  getLlmPreset,
  isDeepSeekBaseUrl,
  isGlm52Model,
  isKimiBaseUrl,
  isKimiK2Model,
  isKimiK3Model,
  isMimoBaseUrl,
  isMimoModel,
  isZhipuBaseUrl,
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

  it('maps vendor host families onto built-in preset keys', () => {
    expect(builtinPresetKeyForBaseUrl('https://api.deepseek.com')).toBe('deepseek')
    expect(builtinPresetKeyForBaseUrl('https://api.moonshot.ai/v1')).toBe('moonshot')
    expect(builtinPresetKeyForBaseUrl('https://api.z.ai/api/paas/v4')).toBe('zhipu')
    expect(builtinPresetKeyForBaseUrl('https://token-plan-cn.xiaomimimo.com/v1')).toBe('mimo')
    expect(builtinPresetKeyForBaseUrl('https://api.openai.com/v1')).toBeNull()
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

  it('ships a built-in GLM preset (5.2 + 4.7-flash) with thinking defaults', () => {
    const glm = getLlmPreset('zhipu')!
    expect(glm.label).toBe('GLM')
    expect(glm.model).toBe('glm-5.2')
    expect(glm.cheapModel).toBe('glm-4.7-flash')
    expect(presetModels(glm)).toEqual(['glm-5.2', 'glm-4.7-flash'])
    expect(glm.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4')
    expect(glm.defaultThinking).toBe('high')
    expect(presetBackendStem(glm.baseName, 'glm-5.2', 0)).toBe('glm-5.2')
    expect(presetBackendStem(glm.baseName, 'glm-4.7-flash', 1)).toBe('glm-4.7-flash')
    expect(isZhipuBaseUrl('https://open.bigmodel.cn/api/paas/v4')).toBe(true)
    expect(isZhipuBaseUrl('https://api.z.ai/api/paas/v4')).toBe(true)
    expect(isGlm52Model('glm-5.2')).toBe(true)
    expect(resolveDefaultThinking('https://open.bigmodel.cn/api/paas/v4', 'glm-5.2')).toBe('high')
  })

  it('ships a built-in MiMo preset (v2.5-pro + v2.5) with thinking defaults', () => {
    const mimo = getLlmPreset('mimo')!
    expect(mimo.label).toBe('MiMo')
    expect(mimo.model).toBe('mimo-v2.5-pro')
    expect(mimo.cheapModel).toBe('mimo-v2.5')
    expect(presetModels(mimo)).toEqual(['mimo-v2.5-pro', 'mimo-v2.5'])
    expect(mimo.baseUrl).toBe('https://api.xiaomimimo.com/v1')
    expect(mimo.defaultThinking).toBe('high')
    expect(presetBackendStem(mimo.baseName, 'mimo-v2.5-pro', 0)).toBe('mimo-v2.5-pro')
    expect(presetBackendStem(mimo.baseName, 'mimo-v2.5', 1)).toBe('mimo-v2.5')
    expect(isMimoBaseUrl('https://api.xiaomimimo.com/v1')).toBe(true)
    expect(isMimoBaseUrl('https://token-plan-cn.xiaomimimo.com/v1')).toBe(true)
    expect(isMimoBaseUrl('https://api.openai.com/v1')).toBe(false)
    expect(isMimoModel('mimo-v2.5-pro')).toBe(true)
    expect(isMimoModel('mimo-v2.5')).toBe(true)
    expect(resolveDefaultThinking('https://api.xiaomimimo.com/v1', 'mimo-v2.5-pro')).toBe('high')
  })

  it('does not ship OpenAI / Anthropic as built-in presets', () => {
    expect(getLlmPreset('openai')).toBeUndefined()
    expect(getLlmPreset('anthropic')).toBeUndefined()
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
