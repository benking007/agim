/**
 * CR M1 — keep SPA offline fallback aligned with backend SSOT.
 * Runtime UI prefers GET /api/llm/presets; this pin catches silent drift
 * in the first-paint mirror at src/web-app/src/lib/llm-presets.ts.
 */

import { describe, it, expect } from 'bun:test'
import { LLM_PRESETS as core } from '../../src/core/llm/presets.ts'
import { LLM_PRESETS as spa } from '../../src/web-app/src/lib/llm-presets.ts'

describe('llm presets SPA↔core drift', () => {
  it('SPA fallback keys match core order and identity fields', () => {
    expect(spa.map((p) => p.key)).toEqual(core.map((p) => p.key))
    for (let i = 0; i < core.length; i += 1) {
      const c = core[i]!
      const s = spa[i]!
      expect(s.key).toBe(c.key)
      expect(s.provider).toBe(c.provider)
      expect(s.baseUrl).toBe(c.baseUrl)
      expect(s.model).toBe(c.model)
      expect(s.cheapModel).toBe(c.cheapModel)
      expect([...(s.models ?? [])]).toEqual([...(c.models ?? [])])
      expect(s.baseName).toBe(c.baseName)
      expect(s.defaultThinking).toBe(c.defaultThinking)
    }
  })
})
