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
const { effectivePlanModeOn, readEnvPlanModeDefault } = planMod

describe('plan-mode-state — env defaults (v1.2.120)', () => {
  const savedEnv = process.env.AGIM_NATIVE_PLAN_MODE
  beforeEach(() => { delete process.env.AGIM_NATIVE_PLAN_MODE })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AGIM_NATIVE_PLAN_MODE
    else process.env.AGIM_NATIVE_PLAN_MODE = savedEnv
  })

  it('readEnvPlanModeDefault parses common truthy values', () => {
    for (const v of ['1', 'on', 'true', 'yes', 'ON', 'True']) {
      process.env.AGIM_NATIVE_PLAN_MODE = v
      expect(readEnvPlanModeDefault()).toBe(true)
    }
  })

  it('readEnvPlanModeDefault rejects unset / falsy / garbage', () => {
    for (const v of ['', '0', 'off', 'no', 'garbage']) {
      process.env.AGIM_NATIVE_PLAN_MODE = v
      expect(readEnvPlanModeDefault()).toBe(false)
    }
    delete process.env.AGIM_NATIVE_PLAN_MODE
    expect(readEnvPlanModeDefault()).toBe(false)
  })

  it('effectivePlanModeOn() with no threadKey ⇒ env-only', () => {
    delete process.env.AGIM_NATIVE_PLAN_MODE
    expect(effectivePlanModeOn()).toBe(false)
    process.env.AGIM_NATIVE_PLAN_MODE = '1'
    expect(effectivePlanModeOn()).toBe(true)
  })

  it('effectivePlanModeOn(threadKey) falls through to env when no per-thread row', () => {
    // Under bun, per-thread DB is a no-op so there's never a row;
    // the per-thread check returns null and we always reach env.
    process.env.AGIM_NATIVE_PLAN_MODE = '1'
    expect(effectivePlanModeOn('nonexistent-thread')).toBe(true)
    delete process.env.AGIM_NATIVE_PLAN_MODE
    expect(effectivePlanModeOn('nonexistent-thread')).toBe(false)
  })
})
