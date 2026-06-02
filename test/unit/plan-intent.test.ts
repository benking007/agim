// v1.2.135 P3 — plan-intent detector.
//
// Pins:
//   (a) CN keyword hits
//   (b) EN keyword hits
//   (c) case-insensitive matching
//   (d) avoids obvious false positives (regular prompts with "plan"
//       as a noun, not the intent)
//   (e) IMHUB_PLAN_INTENT_PHRASES env replaces default list (not merge)
//   (f) master switch IMHUB_PLAN_INTENT_AUTO gates shouldAutoEnterPlanMode

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  detectPlanIntent,
  hasPlanIntent,
  isPlanIntentAutoEnabled,
  shouldAutoEnterPlanMode,
} from '../../src/core/plan-intent.js'

describe('plan-intent — phrase detection (v1.2.135)', () => {
  const saved: Record<string, string | undefined> = {}
  const ENV_KEYS = ['IMHUB_PLAN_INTENT_AUTO', 'IMHUB_PLAN_INTENT_PHRASES']
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('detects common Chinese plan-intent phrases', () => {
    expect(detectPlanIntent('帮我先想想这个怎么做')).toBe('先想想')
    expect(detectPlanIntent('先规划一下方案')).toBe('先规划')
    expect(detectPlanIntent('不要直接做，先讨论')).toBe('先讨论')
    expect(detectPlanIntent('这次只规划，别动手')).toBe('只规划')
  })

  it('detects common English plan-intent phrases (case-insensitive)', () => {
    expect(detectPlanIntent('Plan only, no edits')).toBe('plan only')
    expect(detectPlanIntent('PLAN ONLY please')).toBe('plan only')
    expect(detectPlanIntent("Don't act yet, just sketch")).toBe("don't act yet")
    expect(detectPlanIntent('Let us plan the refactor first')).toBe('let us plan')
    expect(detectPlanIntent('research first then code')).toBe('research first')
  })

  it('returns null for regular prompts (no plan-intent)', () => {
    expect(detectPlanIntent('refactor the auth module')).toBeNull()
    expect(detectPlanIntent('修复登录页的 CSS')).toBeNull()
    expect(detectPlanIntent('add tests for the new feature')).toBeNull()
    // "plan" as a noun (not intent) — should not fire
    expect(detectPlanIntent('show me the database plan schema')).toBeNull()
    // empty / whitespace
    expect(detectPlanIntent('')).toBeNull()
    expect(detectPlanIntent('   ')).toBeNull()
  })

  it('hasPlanIntent boolean wrapper agrees with detectPlanIntent', () => {
    expect(hasPlanIntent('plan only')).toBe(true)
    expect(hasPlanIntent('plain old request')).toBe(false)
  })

  it('IMHUB_PLAN_INTENT_PHRASES replaces default list (not merge)', () => {
    process.env.IMHUB_PLAN_INTENT_PHRASES = 'magic-word,xyz123'
    // Default phrase no longer triggers
    expect(detectPlanIntent('plan only please')).toBeNull()
    // Custom phrase triggers
    expect(detectPlanIntent('use the magic-word for this')).toBe('magic-word')
    expect(detectPlanIntent('try xyz123 path')).toBe('xyz123')
  })

  it('IMHUB_PLAN_INTENT_PHRASES handles empty entries gracefully', () => {
    process.env.IMHUB_PLAN_INTENT_PHRASES = ',,plan only,,'
    expect(detectPlanIntent('plan only')).toBe('plan only')
  })
})

describe('plan-intent — auto-enter master switch', () => {
  const saved = process.env.IMHUB_PLAN_INTENT_AUTO
  afterEach(() => {
    if (saved === undefined) delete process.env.IMHUB_PLAN_INTENT_AUTO
    else process.env.IMHUB_PLAN_INTENT_AUTO = saved
  })

  it('isPlanIntentAutoEnabled is false by default', () => {
    delete process.env.IMHUB_PLAN_INTENT_AUTO
    expect(isPlanIntentAutoEnabled()).toBe(false)
  })

  it('parses common truthy values', () => {
    for (const v of ['on', '1', 'true', 'yes', 'ON', 'True']) {
      process.env.IMHUB_PLAN_INTENT_AUTO = v
      expect(isPlanIntentAutoEnabled()).toBe(true)
    }
  })

  it('parses falsy values', () => {
    for (const v of ['off', '0', 'false', 'no', '']) {
      process.env.IMHUB_PLAN_INTENT_AUTO = v
      expect(isPlanIntentAutoEnabled()).toBe(false)
    }
  })

  it('shouldAutoEnterPlanMode requires BOTH switch on AND intent match', () => {
    // Switch off → never trigger even with matching prompt
    delete process.env.IMHUB_PLAN_INTENT_AUTO
    expect(shouldAutoEnterPlanMode('plan only please')).toBeNull()

    // Switch on but no intent → still null
    process.env.IMHUB_PLAN_INTENT_AUTO = 'on'
    expect(shouldAutoEnterPlanMode('refactor X')).toBeNull()

    // Both → returns matched phrase
    expect(shouldAutoEnterPlanMode('先想想这个')).toBe('先想想')
  })
})
