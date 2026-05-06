// Rate limiter — per-user token bucket for agent invocations

interface Bucket {
  tokens: number
  lastRefill: number
}

const DEFAULT_RATE = 10        // tokens per interval
const DEFAULT_INTERVAL_MS = 60_000 // 1 minute
const DEFAULT_BURST = 15       // max tokens in bucket
/**
 * Threshold for the opportunistic bucket-map sweep performed inside
 * {@link RateLimiter.allow}. Keeps the in-memory map bounded under bursty
 * workloads with high user diversity (one bucket per `user:agent` key,
 * unbounded if never pruned) without needing an external scheduler.
 */
const AUTO_CLEANUP_EVERY_MS = 30 * 60 * 1000
/** Buckets idle for at least this long are dropped on a sweep. */
const DEFAULT_IDLE_MS = 30 * 60 * 1000

export class RateLimiter {
  private buckets = new Map<string, Bucket>()
  private rate: number
  private intervalMs: number
  private burst: number
  private lastSweepAt: number = Date.now()

  constructor(rate = DEFAULT_RATE, intervalMs = DEFAULT_INTERVAL_MS, burst = DEFAULT_BURST) {
    this.rate = rate
    this.intervalMs = intervalMs
    this.burst = burst
  }

  /** Check if a request is allowed. Returns true if within limit. */
  allow(key: string): boolean {
    this.maybeSweep()
    const b = this.getBucket(key)
    if (b.tokens > 0) {
      b.tokens--
      return true
    }
    return false
  }

  /** Get remaining tokens for a key. */
  remaining(key: string): number {
    return this.getBucket(key).tokens
  }

  /** Get status for display. */
  status(key: string): { remaining: number; rate: number; intervalSec: number } {
    return {
      remaining: this.getBucket(key).tokens,
      rate: this.rate,
      intervalSec: Math.round(this.intervalMs / 1000),
    }
  }

  /** Read the bucket's static configuration (no key required). */
  config(): { rate: number; intervalSec: number; burst: number } {
    return {
      rate: this.rate,
      intervalSec: Math.round(this.intervalMs / 1000),
      burst: this.burst,
    }
  }

  /**
   * Best-effort estimate (epoch ms) of when the next token will be available
   * for `key`. If the bucket already has tokens, returns now.
   */
  nextAllowAt(key: string): number {
    const b = this.getBucket(key)
    if (b.tokens > 0) return Date.now()
    // We add `rate` tokens every `intervalMs` from `lastRefill`. The next
    // refill arrives at `lastRefill + intervalMs`.
    return b.lastRefill + this.intervalMs
  }

  /**
   * Drop buckets that have been idle for at least `idleMs` milliseconds.
   * Run periodically to bound memory under bursty workloads.
   *
   * Called automatically by {@link allow} every {@link AUTO_CLEANUP_EVERY_MS},
   * but exposed publicly so ops / tests can force a sweep.
   */
  cleanup(idleMs = DEFAULT_IDLE_MS): number {
    const now = Date.now()
    let dropped = 0
    for (const [key, b] of this.buckets) {
      if (now - b.lastRefill > idleMs) {
        this.buckets.delete(key)
        dropped++
      }
    }
    return dropped
  }

  /** Test/diagnostic accessor: how many distinct keys are tracked. */
  size(): number { return this.buckets.size }

  private maybeSweep(): void {
    const now = Date.now()
    if (now - this.lastSweepAt < AUTO_CLEANUP_EVERY_MS) return
    this.lastSweepAt = now
    this.cleanup()
  }

  private getBucket(key: string): Bucket {
    const now = Date.now()
    let b = this.buckets.get(key)
    if (!b) {
      b = { tokens: this.burst, lastRefill: now }
      this.buckets.set(key, b)
      return b
    }
    // Refill tokens based on elapsed time
    const elapsed = now - b.lastRefill
    const refill = Math.floor(elapsed / this.intervalMs) * this.rate
    if (refill > 0) {
      b.tokens = Math.min(this.burst, b.tokens + refill)
      b.lastRefill = now
    }
    return b
  }
}

// Global instances
export const userLimiter = new RateLimiter(10, 60000, 15)    // 10 req/min per user
export const agentLimiter = new RateLimiter(30, 60000, 50)   // 30 req/min per agent
