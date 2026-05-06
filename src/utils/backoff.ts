// Exponential backoff with jitter — used by IM adapter reconnect loops.
//
// Why: when an IM platform throws (auth revoked, network blip, server
// outage) the adapter retries. With fixed delays we have three problems:
//
//   1. Auth revoked → infinite fast hammering of the IM API at the same
//      cadence; with backoff the cadence relaxes to capMs.
//   2. Multi-instance fleet recovering from a network event reconnects
//      in lock-step at the same fixed delay — thundering herd hits the
//      IM platform's load balancer; jitter spreads the storm.
//   3. Flaky network → CPU spent in tight reconnect loop; longer waits
//      between attempts dampen this.
//
// Used by:
//   - telegram-adapter runPollingLoop (was fixed 2s/5s delays)
//   - wechat ilink-adapter polling loop (had exp backoff but no jitter)

export interface BackoffOptions {
  /** Initial delay in ms. Doubles each attempt up to capMs. Default 1000. */
  baseMs?: number
  /** Maximum delay in ms before jitter. Default 60_000. */
  capMs?: number
  /** Multiplicative jitter range in [0, 1]. The actual delay is sampled
   *  uniformly from `[exp * (1 - jitter), exp * (1 + jitter)]`. Set to 0
   *  for deterministic delays (testing). Default 0.5. */
  jitter?: number
  /** Pluggable RNG for deterministic tests. Defaults to Math.random. */
  random?: () => number
}

const DEFAULT_BASE_MS = 1_000
const DEFAULT_CAP_MS = 60_000
const DEFAULT_JITTER = 0.5

export class Backoff {
  private attempt = 0
  private readonly baseMs: number
  private readonly capMs: number
  private readonly jitter: number
  private readonly random: () => number

  constructor(opts: BackoffOptions = {}) {
    this.baseMs = Math.max(0, opts.baseMs ?? DEFAULT_BASE_MS)
    this.capMs = Math.max(this.baseMs, opts.capMs ?? DEFAULT_CAP_MS)
    this.jitter = Math.max(0, Math.min(1, opts.jitter ?? DEFAULT_JITTER))
    this.random = opts.random ?? Math.random
  }

  /**
   * Compute the next delay in ms and increment the attempt counter.
   *
   *   - First call:  ~baseMs (jittered)
   *   - Each call doubles the unjittered exponent until it hits capMs
   *   - Then every subsequent call returns ~capMs (jittered)
   *
   * Returns a non-negative integer.
   */
  nextDelayMs(): number {
    const exp = Math.min(this.capMs, this.baseMs * Math.pow(2, this.attempt))
    this.attempt += 1
    if (this.jitter === 0) return Math.floor(exp)
    // Multiplicative jitter: factor ∈ [1 - jitter, 1 + jitter]
    const factor = 1 + (this.random() * 2 - 1) * this.jitter
    return Math.max(0, Math.floor(exp * factor))
  }

  /** Reset attempt counter — call after a successful operation. */
  reset(): void {
    this.attempt = 0
  }

  /** Diagnostic: current attempt count without bumping. */
  currentAttempt(): number {
    return this.attempt
  }
}
