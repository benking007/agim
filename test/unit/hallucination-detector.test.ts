// v1.2.147 — hallucination detector tests.
//
// Covers: ZH/EN narration patterns, direct-write-block (the user's
// real fail mode), promise-no-action without tool reference, and the
// false-positive guards (real toolCalls present, unknown tool name,
// short text).

import { describe, expect, test } from 'bun:test'
import {
  detectHallucinatedToolCall,
  isHallucinationDetectorOn,
} from '../../src/core/llm/hallucination-detector.js'

const TOOLS = ['agim_write_file', 'agim_read_file', 'agim_exec', 'agim_web_fetch']

describe('detectHallucinatedToolCall — POSITIVE cases', () => {
  test('ZH: direct-write-block — "直接写：```python ..."', () => {
    const v = detectHallucinatedToolCall({
      text: '好，直接写文件：\n```python\nprint("hi")\n```',
      toolNames: TOOLS,
      emittedToolCallCount: 0,
    })
    expect(v.hallucinated).toBe(true)
    expect(v.pattern).toBe('zh:direct-write-block')
    expect(v.evidence).toMatch(/直接\s*写/)
  })

  test('ZH: direct-write-block — "这次不废话，直接写：```"', () => {
    const v = detectHallucinatedToolCall({
      text: '这次不废话，直接写：\n```\nfoo\n```',
      toolNames: TOOLS,
      emittedToolCallCount: 0,
    })
    expect(v.hallucinated).toBe(true)
    expect(v.pattern).toBe('zh:direct-write-block')
  })

  test('ZH: invoke-narration — "我现在调用 agim_write_file"', () => {
    const v = detectHallucinatedToolCall({
      text: '好，我现在调用 agim_write_file 把文件存下来。',
      toolNames: TOOLS,
      emittedToolCallCount: 0,
    })
    expect(v.hallucinated).toBe(true)
    expect(v.pattern).toBe('zh:invoke-narration')
  })

  test('ZH: invoke-narration — "这就调 agim_exec"', () => {
    const v = detectHallucinatedToolCall({
      text: '行，这就调 agim_exec 跑一遍。',
      toolNames: TOOLS,
      emittedToolCallCount: 0,
    })
    expect(v.hallucinated).toBe(true)
    expect(v.pattern).toBe('zh:invoke-narration')
  })

  test('EN: invoke-narration — "I will call agim_write_file"', () => {
    const v = detectHallucinatedToolCall({
      text: 'OK, I will call agim_write_file with the content below.',
      toolNames: TOOLS,
      emittedToolCallCount: 0,
    })
    expect(v.hallucinated).toBe(true)
    expect(v.pattern).toBe('en:invoke-narration')
  })

  test("EN: invoke-narration — \"Let me invoke agim_exec\"", () => {
    const v = detectHallucinatedToolCall({
      text: 'Let me invoke agim_exec now.',
      toolNames: TOOLS,
      emittedToolCallCount: 0,
    })
    expect(v.hallucinated).toBe(true)
    expect(v.pattern).toBe('en:invoke-narration')
  })

  test('ZH: promise-no-action — "这次不废话，直接写。"', () => {
    const v = detectHallucinatedToolCall({
      text: '这次不废话，直接写。',
      toolNames: TOOLS,
      emittedToolCallCount: 0,
    })
    expect(v.hallucinated).toBe(true)
    expect(v.pattern).toBe('zh:promise-no-action')
  })
})

describe('detectHallucinatedToolCall — NEGATIVE / guard cases', () => {
  test('NEG: model actually emitted a tool call → not flagged', () => {
    const v = detectHallucinatedToolCall({
      text: '我现在调用 agim_write_file 把文件存下来。',
      toolNames: TOOLS,
      emittedToolCallCount: 1,
    })
    expect(v.hallucinated).toBe(false)
  })

  test('NEG: narration references unknown tool → not flagged', () => {
    const v = detectHallucinatedToolCall({
      text: '我现在调用 native_make_coffee 给你倒杯咖啡。',
      toolNames: TOOLS,
      emittedToolCallCount: 0,
    })
    expect(v.hallucinated).toBe(false)
  })

  test('NEG: empty text → not flagged', () => {
    const v = detectHallucinatedToolCall({ text: '', toolNames: TOOLS, emittedToolCallCount: 0 })
    expect(v.hallucinated).toBe(false)
  })

  test('NEG: very short text → not flagged', () => {
    const v = detectHallucinatedToolCall({ text: '好', toolNames: TOOLS, emittedToolCallCount: 0 })
    expect(v.hallucinated).toBe(false)
  })

  test('NEG: past tense "已经调过 agim_write_file" — does not match invoke patterns', () => {
    const v = detectHallucinatedToolCall({
      text: '我已经调过 agim_write_file 了，文件应该存好了。',
      toolNames: TOOLS,
      emittedToolCallCount: 0,
    })
    // We don't flag past-tense self-reports — that's a separate
    // "lie-about-history" failure mode, out of scope for this detector.
    expect(v.hallucinated).toBe(false)
  })

  test('NEG: code block without "直接写" intro → not flagged', () => {
    const v = detectHallucinatedToolCall({
      text: '这里是示例代码：\n```python\nprint("hi")\n```',
      toolNames: TOOLS,
      emittedToolCallCount: 0,
    })
    expect(v.hallucinated).toBe(false)
  })
})

describe('isHallucinationDetectorOn', () => {
  test('default ON when env unset', () => {
    delete process.env.AGIM_NATIVE_HALLUCINATION_DETECT
    expect(isHallucinationDetectorOn()).toBe(true)
  })

  test('OFF when env=off', () => {
    process.env.AGIM_NATIVE_HALLUCINATION_DETECT = 'off'
    expect(isHallucinationDetectorOn()).toBe(false)
    delete process.env.AGIM_NATIVE_HALLUCINATION_DETECT
  })

  test('OFF when env=0', () => {
    process.env.AGIM_NATIVE_HALLUCINATION_DETECT = '0'
    expect(isHallucinationDetectorOn()).toBe(false)
    delete process.env.AGIM_NATIVE_HALLUCINATION_DETECT
  })

  test('ON for unrecognized values (e.g. "yes")', () => {
    process.env.AGIM_NATIVE_HALLUCINATION_DETECT = 'yes'
    expect(isHallucinationDetectorOn()).toBe(true)
    delete process.env.AGIM_NATIVE_HALLUCINATION_DETECT
  })
})
