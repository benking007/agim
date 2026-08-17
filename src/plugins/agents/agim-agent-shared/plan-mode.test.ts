// v1.2.119 — PlanMode contract:
//   (a) Env AGIM_NATIVE_PLAN_MODE=1 (or 'on'/'true'/'yes') turns on
//   (b) When on, resolvePolicy().denyList contains the write+exec tools
//   (c) Other env values → off (back-compat)

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { isPlanModeOn, resolvePolicy } from './index.js'

describe('PlanMode (v1.2.119)', () => {
  const saved = process.env.AGIM_NATIVE_PLAN_MODE
  const savedDisable = process.env.AGIM_DISABLE_PLAN_MODE
  const savedUnified = process.env.AGIM_PLAN_MODE
  beforeEach(() => {
    delete process.env.AGIM_NATIVE_PLAN_MODE
    delete process.env.AGIM_DISABLE_PLAN_MODE
    delete process.env.AGIM_PLAN_MODE
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.AGIM_NATIVE_PLAN_MODE
    else process.env.AGIM_NATIVE_PLAN_MODE = saved
    if (savedDisable === undefined) delete process.env.AGIM_DISABLE_PLAN_MODE
    else process.env.AGIM_DISABLE_PLAN_MODE = savedDisable
    if (savedUnified === undefined) delete process.env.AGIM_PLAN_MODE
    else process.env.AGIM_PLAN_MODE = savedUnified
  })

  describe('isPlanModeOn', () => {
    it.each([['1', true], ['on', true], ['true', true], ['yes', true],
             ['ON', true], ['True', true],
             ['', false], ['0', false], ['off', false], ['no', false]])(
      'env %p ⇒ on=%p',
      (val, expected) => {
        process.env.AGIM_NATIVE_PLAN_MODE = val
        expect(isPlanModeOn()).toBe(expected)
      },
    )

    it('unset env ⇒ off', () => {
      delete process.env.AGIM_NATIVE_PLAN_MODE
      expect(isPlanModeOn()).toBe(false)
    })

    it('AGIM_DISABLE_PLAN_MODE overrides env and persisted defaults', () => {
      process.env.AGIM_NATIVE_PLAN_MODE = '1'
      process.env.AGIM_DISABLE_PLAN_MODE = '1'
      expect(isPlanModeOn()).toBe(false)
      expect(resolvePolicy().denyList).not.toContain('agim_write_file')
    })
  })

  describe('resolvePolicy applies plan-mode denylist', () => {
    it('plan mode OFF: denyList unchanged from user-supplied AGIM_NATIVE_AGENT_DENYLIST', () => {
      delete process.env.AGIM_NATIVE_PLAN_MODE
      process.env.AGIM_NATIVE_AGENT_DENYLIST = 'foo_tool,bar_tool'
      try {
        const p = resolvePolicy()
        expect(p.denyList).toEqual(['foo_tool', 'bar_tool'])
      } finally {
        delete process.env.AGIM_NATIVE_AGENT_DENYLIST
      }
    })

    it('plan mode ON: write/edit/exec/git-mutate/test/gate appended to denyList', () => {
      process.env.AGIM_NATIVE_PLAN_MODE = '1'
      const p = resolvePolicy()
      expect(p.denyList).toContain('agim_write_file')
      expect(p.denyList).toContain('agim_edit_file')
      expect(p.denyList).toContain('agim_exec')
      expect(p.denyList).toContain('agim_git_add')
      expect(p.denyList).toContain('agim_git_commit')
      expect(p.denyList).toContain('agim_test_run')
      expect(p.denyList).toContain('agim_quality_gate')
    })

    it('plan mode ON + user denylist: union (no duplicates)', () => {
      process.env.AGIM_NATIVE_PLAN_MODE = 'true'
      process.env.AGIM_NATIVE_AGENT_DENYLIST = 'agim_write_file,my_custom_tool'
      try {
        const p = resolvePolicy()
        expect(p.denyList).toContain('agim_write_file')
        expect(p.denyList).toContain('agim_exec')
        expect(p.denyList).toContain('my_custom_tool')
        // No duplicates
        const denyList = p.denyList ?? []
        const seen = new Set(denyList)
        expect(seen.size).toBe(denyList.length)
      } finally {
        delete process.env.AGIM_NATIVE_AGENT_DENYLIST
      }
    })
  })
})
