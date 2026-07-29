import { afterEach, describe, expect, it } from 'bun:test'
import {
  CALL_AGENT_MAX_PER_TURN_DEFAULT,
  CALL_AGENTS_TASKS_HARD_MAX,
  SUBAGENT_PARALLEL_MAX_DEFAULT,
  getCallAgentMaxPerTurn,
  getSubagentParallelMax,
  isSubagentParallelEnabled,
  mapPool,
} from './subagent-parallel.js'

const ENV_KEYS = [
  'AGIM_SUBAGENT_PARALLEL',
  'AGIM_SUBAGENT_PARALLEL_MAX',
  'AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN',
] as const

const SNAPSHOT: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) SNAPSHOT[k] = process.env[k]

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = SNAPSHOT[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('isSubagentParallelEnabled', () => {
  it('defaults ON when unset', () => {
    delete process.env.AGIM_SUBAGENT_PARALLEL
    expect(isSubagentParallelEnabled()).toBe(true)
  })

  it('accepts explicit off spellings', () => {
    for (const v of ['0', 'off', 'false', 'no', 'OFF']) {
      process.env.AGIM_SUBAGENT_PARALLEL = v
      expect(isSubagentParallelEnabled()).toBe(false)
    }
  })

  it('accepts explicit on spellings', () => {
    for (const v of ['1', 'on', 'true', 'yes']) {
      process.env.AGIM_SUBAGENT_PARALLEL = v
      expect(isSubagentParallelEnabled()).toBe(true)
    }
  })
})

describe('getSubagentParallelMax / getCallAgentMaxPerTurn', () => {
  it('uses Phase B defaults', () => {
    delete process.env.AGIM_SUBAGENT_PARALLEL_MAX
    delete process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN
    expect(SUBAGENT_PARALLEL_MAX_DEFAULT).toBe(3)
    expect(CALL_AGENT_MAX_PER_TURN_DEFAULT).toBe(6)
    expect(getSubagentParallelMax()).toBe(SUBAGENT_PARALLEL_MAX_DEFAULT)
    expect(getCallAgentMaxPerTurn()).toBe(CALL_AGENT_MAX_PER_TURN_DEFAULT)
  })

  it('clamps PARALLEL_MAX to hard task ceiling', () => {
    process.env.AGIM_SUBAGENT_PARALLEL_MAX = '99'
    expect(getSubagentParallelMax()).toBe(CALL_AGENTS_TASKS_HARD_MAX)
  })

  it('allows MAX_PER_TURN=0 to disable the cap', () => {
    process.env.AGIM_NATIVE_CALL_AGENT_MAX_PER_TURN = '0'
    expect(getCallAgentMaxPerTurn()).toBe(0)
  })
})

describe('mapPool', () => {
  it('preserves order and respects concurrency', async () => {
    let live = 0
    let peak = 0
    const out = await mapPool([10, 20, 30, 40], 2, async (n) => {
      live += 1
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 15))
      live -= 1
      return n * 2
    })
    expect(out).toEqual([20, 40, 60, 80])
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThanOrEqual(2)
  })

  it('does not cancel siblings when one fn throws (caller catches)', async () => {
    const out = await mapPool([1, 2, 3], 3, async (n) => {
      try {
        if (n === 2) throw new Error('boom')
        return { ok: true as const, n }
      } catch (err) {
        return { ok: false as const, n, err: err instanceof Error ? err.message : String(err) }
      }
    })
    expect(out[0]).toEqual({ ok: true, n: 1 })
    expect(out[1]).toEqual({ ok: false, n: 2, err: 'boom' })
    expect(out[2]).toEqual({ ok: true, n: 3 })
  })
})
