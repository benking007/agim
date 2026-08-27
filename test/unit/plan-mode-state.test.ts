// v1.2.120 — plan-mode-state precedence logic.
//
// Note: better-sqlite3 is not supported under bun (sqlite-helper
// degrades to graceful no-op). The SQLite CRUD paths (set / get /
// clear) are exercised in production (node) but cannot be asserted
// under bun. This suite covers the parts that are pure: env parsing
// + the "no threadKey ⇒ env-only" branch of effectivePlanModeOn.
// The SQLite-dependent precedence rules ("per-thread wins") are
// asserted at the slash-command layer in plan.test.ts which mocks
// sessionManager + the storage shim.

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'

const planMod = await import('../../src/core/plan-mode-state.js')
const {
  effectivePlanModeOn,
  readEnvPlanModeDefault,
  resolvePlanModeEnvPolicy,
} = planMod

describe('plan-mode-state — env defaults', () => {
  const savedNative = process.env.AGIM_NATIVE_PLAN_MODE
  const savedDisable = process.env.AGIM_DISABLE_PLAN_MODE
  const savedUnified = process.env.AGIM_PLAN_MODE
  beforeEach(() => {
    delete process.env.AGIM_NATIVE_PLAN_MODE
    delete process.env.AGIM_DISABLE_PLAN_MODE
    delete process.env.AGIM_PLAN_MODE
  })
  afterEach(() => {
    if (savedNative === undefined) delete process.env.AGIM_NATIVE_PLAN_MODE
    else process.env.AGIM_NATIVE_PLAN_MODE = savedNative
    if (savedDisable === undefined) delete process.env.AGIM_DISABLE_PLAN_MODE
    else process.env.AGIM_DISABLE_PLAN_MODE = savedDisable
    if (savedUnified === undefined) delete process.env.AGIM_PLAN_MODE
    else process.env.AGIM_PLAN_MODE = savedUnified
  })

  it('AGIM_PLAN_MODE is the canonical process policy', () => {
    process.env.AGIM_PLAN_MODE = 'on'
    expect(resolvePlanModeEnvPolicy()).toBe('on')
    expect(readEnvPlanModeDefault()).toBe(true)
    process.env.AGIM_PLAN_MODE = 'off'
    expect(resolvePlanModeEnvPolicy()).toBe('off')
    process.env.AGIM_PLAN_MODE = 'disabled'
    expect(resolvePlanModeEnvPolicy()).toBe('disabled')
    expect(effectivePlanModeOn()).toBe(false)
  })

  it('legacy AGIM_NATIVE_PLAN_MODE still enables default-on', () => {
    for (const v of ['1', 'on', 'true', 'yes', 'ON', 'True']) {
      process.env.AGIM_NATIVE_PLAN_MODE = v
      expect(readEnvPlanModeDefault()).toBe(true)
    }
  })

  it('legacy AGIM_DISABLE_PLAN_MODE=1 maps to disabled', () => {
    process.env.AGIM_NATIVE_PLAN_MODE = '1'
    process.env.AGIM_DISABLE_PLAN_MODE = '1'
    expect(resolvePlanModeEnvPolicy()).toBe('disabled')
    expect(effectivePlanModeOn('any')).toBe(false)
  })

  it('canonical AGIM_PLAN_MODE wins over legacy keys', () => {
    process.env.AGIM_NATIVE_PLAN_MODE = '1'
    process.env.AGIM_DISABLE_PLAN_MODE = '1'
    process.env.AGIM_PLAN_MODE = 'on'
    expect(resolvePlanModeEnvPolicy()).toBe('on')
  })

  it('effectivePlanModeOn() with no threadKey ⇒ env-only', () => {
    expect(effectivePlanModeOn()).toBe(false)
    process.env.AGIM_PLAN_MODE = 'on'
    expect(effectivePlanModeOn()).toBe(true)
  })
})

describe('plan-mode-state — live in-flight override', () => {
  afterEach(() => {
    planMod._resetLivePlanModeForTests()
    delete process.env.AGIM_PLAN_MODE
  })

  it('live override beats env and is cleared by reset', () => {
    process.env.AGIM_PLAN_MODE = 'on'
    expect(planMod.effectivePlanModeOn('t-live')).toBe(true)
    planMod.setLivePlanMode('t-live', false)
    expect(planMod.effectivePlanModeOn('t-live')).toBe(false)
    expect(planMod.getLivePlanMode('t-live')).toBe(false)
    planMod._resetLivePlanModeForTests()
    expect(planMod.getLivePlanMode('t-live')).toBeUndefined()
    expect(planMod.effectivePlanModeOn('t-live')).toBe(true)
  })
})
