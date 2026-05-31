// v1.2.119 — PlanMode contract:
//   (a) Env IMHUB_NATIVE_PLAN_MODE=1 (or 'on'/'true'/'yes') turns on
//   (b) When on, resolvePolicy().denyList contains the write+exec tools
//   (c) Other env values → off (back-compat)

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { isPlanModeOn, resolvePolicy } from './index.js'

describe('PlanMode (v1.2.119)', () => {
  const saved = process.env.IMHUB_NATIVE_PLAN_MODE
  beforeEach(() => { delete process.env.IMHUB_NATIVE_PLAN_MODE })
  afterEach(() => {
    if (saved === undefined) delete process.env.IMHUB_NATIVE_PLAN_MODE
    else process.env.IMHUB_NATIVE_PLAN_MODE = saved
  })

  describe('isPlanModeOn', () => {
    it.each([['1', true], ['on', true], ['true', true], ['yes', true],
             ['ON', true], ['True', true],
             ['', false], ['0', false], ['off', false], ['no', false]])(
      'env %p ⇒ on=%p',
      (val, expected) => {
        process.env.IMHUB_NATIVE_PLAN_MODE = val
        expect(isPlanModeOn()).toBe(expected)
      },
    )

    it('unset env ⇒ off', () => {
      delete process.env.IMHUB_NATIVE_PLAN_MODE
      expect(isPlanModeOn()).toBe(false)
    })
  })

  describe('resolvePolicy applies plan-mode denylist', () => {
    it('plan mode OFF: denyList unchanged from user-supplied IMHUB_NATIVE_AGENT_DENYLIST', () => {
      delete process.env.IMHUB_NATIVE_PLAN_MODE
      process.env.IMHUB_NATIVE_AGENT_DENYLIST = 'foo_tool,bar_tool'
      try {
        const p = resolvePolicy()
        expect(p.denyList).toEqual(['foo_tool', 'bar_tool'])
      } finally {
        delete process.env.IMHUB_NATIVE_AGENT_DENYLIST
      }
    })

    it('plan mode ON: native_write_file + native_exec appended to denyList', () => {
      process.env.IMHUB_NATIVE_PLAN_MODE = '1'
      const p = resolvePolicy()
      expect(p.denyList).toContain('native_write_file')
      expect(p.denyList).toContain('native_exec')
    })

    it('plan mode ON + user denylist: union (no duplicates)', () => {
      process.env.IMHUB_NATIVE_PLAN_MODE = 'true'
      process.env.IMHUB_NATIVE_AGENT_DENYLIST = 'native_write_file,my_custom_tool'
      try {
        const p = resolvePolicy()
        expect(p.denyList).toContain('native_write_file')
        expect(p.denyList).toContain('native_exec')
        expect(p.denyList).toContain('my_custom_tool')
        // No duplicates
        const seen = new Set(p.denyList ?? [])
        expect(seen.size).toBe(p.denyList?.length)
      } finally {
        delete process.env.IMHUB_NATIVE_AGENT_DENYLIST
      }
    })
  })
})
