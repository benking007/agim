// Unit tests for the per-agent circuit breaker

import { describe, it, expect } from 'bun:test'

// Use a fresh class per test to avoid the global singleton's hidden state.
import { circuitBreaker as globalBreaker } from '../../src/core/circuit-breaker'

// We re-import the file to access the underlying class via prototype hop.
// The module exposes only the singleton; tests build new instances via the
// singleton's constructor (`Object.getPrototypeOf` → `constructor`).
const Breaker: new (threshold?: number, cooldownMs?: number) => typeof globalBreaker =
  Object.getPrototypeOf(globalBreaker).constructor

describe('CircuitBreaker', () => {
  it('stays closed under threshold', () => {
    const br = new Breaker(3, 1_000)
    br.recordFailure('a')
    br.recordFailure('a')
    expect(br.isOpen('a')).toBe(false)
  })

  it('opens at threshold and lists open agents', () => {
    const br = new Breaker(3, 1_000)
    br.recordFailure('a')
    br.recordFailure('a')
    const justOpened = br.recordFailure('a')
    expect(justOpened).toBe(true)
    expect(br.isOpen('a')).toBe(true)
    expect(br.listOpen()).toEqual(['a'])
  })

  it('does not re-open on subsequent failures while open', () => {
    const br = new Breaker(2, 1_000)
    br.recordFailure('a')
    expect(br.recordFailure('a')).toBe(true)
    // already open: subsequent failure must not return true again
    expect(br.recordFailure('a')).toBe(false)
  })

  it('grants exactly one probe after cooldown (half-open semantics)', async () => {
    const br = new Breaker(2, 30)
    br.recordFailure('a')
    br.recordFailure('a')
    expect(br.isOpen('a')).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    // First caller after cooldown gets the probe slot — sees not-open.
    expect(br.isOpen('a')).toBe(false)
    // Subsequent concurrent callers see the breaker as open until the probe
    // resolves (recordSuccess → close, or recordFailure → re-open).
    expect(br.isOpen('a')).toBe(true)
    const status = br.getStatus('a')
    expect(status.phase).toBe('half-open')
  })

  it('probe success closes the breaker fully', async () => {
    const br = new Breaker(2, 20)
    br.recordFailure('a')
    br.recordFailure('a')
    await new Promise((r) => setTimeout(r, 30))
    br.isOpen('a')  // claim the probe
    br.recordSuccess('a')
    expect(br.isOpen('a')).toBe(false)
    expect(br.getStatus('a').phase).toBe('closed')
  })

  it('probe failure re-opens with doubled cooldown (capped)', async () => {
    const br = new Breaker(2, 20)
    br.recordFailure('a')
    br.recordFailure('a')
    const initialCooldown = br.getStatus('a').cooldownMs
    await new Promise((r) => setTimeout(r, 30))
    br.isOpen('a')  // → half-open
    const justOpened = br.recordFailure('a')
    expect(justOpened).toBe(true)
    expect(br.getStatus('a').phase).toBe('open')
    expect(br.getStatus('a').cooldownMs).toBe(initialCooldown * 2)
  })

  it('reset(agent) clears state for that agent only', () => {
    const br = new Breaker(2, 1_000)
    br.recordFailure('a')
    br.recordFailure('a')
    br.recordFailure('b')
    expect(br.isOpen('a')).toBe(true)
    br.reset('a')
    expect(br.isOpen('a')).toBe(false)
    expect(br.getStatus('b').failures).toBe(1)
  })

  it('reset() with no args clears everything', () => {
    const br = new Breaker(2, 1_000)
    br.recordFailure('a'); br.recordFailure('a')
    br.recordFailure('b'); br.recordFailure('b')
    br.reset()
    expect(br.listOpen()).toEqual([])
  })

  it('recordSuccess immediately closes', () => {
    const br = new Breaker(2, 1_000)
    br.recordFailure('a')
    br.recordFailure('a')
    expect(br.isOpen('a')).toBe(true)
    br.recordSuccess('a')
    expect(br.isOpen('a')).toBe(false)
    expect(br.listOpen()).toEqual([])
  })

  it('isolates agents independently', () => {
    const br = new Breaker(2, 1_000)
    br.recordFailure('a')
    br.recordFailure('a')
    expect(br.isOpen('a')).toBe(true)
    expect(br.isOpen('b')).toBe(false)
  })

  // --- peek() / acquireProbe(): side-effect-free routing checks (bug #1) ---

  it('peek() never consumes the half-open probe', async () => {
    const br = new Breaker(2, 20)
    br.recordFailure('a')
    br.recordFailure('a')
    expect(br.peek('a')).toBe(true) // open, cooldown active → blocked
    await new Promise((r) => setTimeout(r, 30))
    // Cooldown elapsed: peek reports eligible (false) WITHOUT flipping phase.
    expect(br.peek('a')).toBe(false)
    expect(br.peek('a')).toBe(false) // still eligible — no probe was consumed
    expect(br.getStatus('a').phase).toBe('open')
  })

  it('peek() does not leave the breaker stuck half-open (regression for #1)', async () => {
    // Reproduces the classifier-filter bug: a read-only check over a
    // cooled-down agent must not strand the breaker in half-open.
    const br = new Breaker(2, 20)
    br.recordFailure('a')
    br.recordFailure('a')
    await new Promise((r) => setTimeout(r, 30))
    // Simulate intent classifier filtering all agents with peek().
    void br.peek('a')
    void br.peek('a')
    // A subsequent real call commits and claims the probe.
    br.acquireProbe('a')
    expect(br.getStatus('a').phase).toBe('half-open')
    br.recordSuccess('a')
    expect(br.peek('a')).toBe(false)
    expect(br.getStatus('a').phase).toBe('closed')
  })

  it('acquireProbe() flips open→half-open only after cooldown', async () => {
    const br = new Breaker(2, 30)
    br.recordFailure('a')
    br.recordFailure('a')
    // Cooldown still active: acquireProbe is a no-op.
    br.acquireProbe('a')
    expect(br.getStatus('a').phase).toBe('open')
    await new Promise((r) => setTimeout(r, 40))
    br.acquireProbe('a')
    expect(br.getStatus('a').phase).toBe('half-open')
  })

  it('acquireProbe() is a no-op when closed or already half-open', async () => {
    const br = new Breaker(2, 20)
    br.acquireProbe('a') // closed → no-op
    expect(br.getStatus('a').phase).toBe('closed')
    br.recordFailure('a')
    br.recordFailure('a')
    await new Promise((r) => setTimeout(r, 30))
    br.acquireProbe('a') // → half-open
    br.acquireProbe('a') // idempotent
    expect(br.getStatus('a').phase).toBe('half-open')
  })
})
