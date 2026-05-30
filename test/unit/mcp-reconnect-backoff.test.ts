// v1.2.108 — locks the exponential reconnect-backoff arithmetic.
// v1.2.96 used a flat 5-second cooldown; a permanently-broken MCP
// server would still get retried every 5 seconds in perpetuity. The
// upgrade doubles the wait per consecutive failure (capped at 60s) and
// resets to 0 on a successful reconnect, so the noise budget stays
// bounded.

import { describe, it, expect } from 'bun:test'
import { computeReconnectCooldownMs } from '../../src/core/llm/mcp-registry.js'

describe('computeReconnectCooldownMs', () => {
  it('failures=0 (fresh / just recovered) → base', () => {
    expect(computeReconnectCooldownMs(0, 5_000, 60_000)).toBe(5_000)
  })

  it('failures=1 → base * 2', () => {
    expect(computeReconnectCooldownMs(1, 5_000, 60_000)).toBe(10_000)
  })

  it('failures=2 → base * 4', () => {
    expect(computeReconnectCooldownMs(2, 5_000, 60_000)).toBe(20_000)
  })

  it('failures=3 → base * 8', () => {
    expect(computeReconnectCooldownMs(3, 5_000, 60_000)).toBe(40_000)
  })

  it('failures=4 → capped at the max', () => {
    expect(computeReconnectCooldownMs(4, 5_000, 60_000)).toBe(60_000)
  })

  it('many failures → still capped at the max (no overflow)', () => {
    expect(computeReconnectCooldownMs(20, 5_000, 60_000)).toBe(60_000)
    expect(computeReconnectCooldownMs(50, 5_000, 60_000)).toBe(60_000)
  })

  it('negative failures defensively → base', () => {
    expect(computeReconnectCooldownMs(-1, 5_000, 60_000)).toBe(5_000)
  })

  it('custom base/cap honored', () => {
    expect(computeReconnectCooldownMs(0, 1_000, 4_000)).toBe(1_000)
    expect(computeReconnectCooldownMs(1, 1_000, 4_000)).toBe(2_000)
    expect(computeReconnectCooldownMs(2, 1_000, 4_000)).toBe(4_000)
    expect(computeReconnectCooldownMs(3, 1_000, 4_000)).toBe(4_000) // capped
  })
})
