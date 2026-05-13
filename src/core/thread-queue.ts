// Per-thread serial queue for agent invocations.
//
// Problem: messenger adapters (wechat-ilink polling, telegram getUpdates,
// feishu/dingtalk/discord event callbacks) all dispatch incoming messages
// as fire-and-forget async calls. When a single user sends two messages
// quickly, both handleMessage runs start concurrently. Downstream effects:
//
//   - claude-code: the same --session-id is reused; the second spawn fails
//     with "session already exists".
//   - codex: same conversation file written by two CLI processes.
//   - opencode (HTTP): server-side session may queue or reject, but
//     im-hub's session-update PATCH dedup is the only thing we have.
//   - opencode (stdio): two writes interleaved into one stdin pipe.
//
// The agent-base.ts contract already says per-call state is local, so
// concurrency across different threadIds is safe — only same-thread
// concurrency is the problem.
//
// Fix: serialize agent invocations per (platform, channelId, threadId).
// Built-in commands, approval replies, and slash commands bypass the
// queue (they need to stay parallel — e.g. a `y` reply must reach the
// approval bus even while an agent run is in-flight on the same thread).

const queues = new Map<string, Promise<unknown>>()
const depths = new Map<string, number>()

export interface ThreadQueueOpts {
  /** Called once if this run had to wait. `ahead` is the number of runs
   *  queued before this one (0 = this is the new tail with nobody waiting,
   *  1 = one predecessor in flight, etc.). Use this to notify the user
   *  that their message was received but is queued. Fired before the
   *  wait begins. Throwing in the callback is swallowed. */
  onQueued?: (ahead: number) => void | Promise<void>
}

/** Run `fn` while holding the per-key serial lock. Subsequent calls with
 *  the same key wait until prior ones settle (success or failure). The
 *  promise-chain pattern guarantees FIFO ordering. */
export async function runOnThread<T>(
  key: string,
  fn: () => Promise<T>,
  opts: ThreadQueueOpts = {},
): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve()
  const ahead = depths.get(key) ?? 0

  if (ahead > 0 && opts.onQueued) {
    // Don't await — the notify should not block joining the queue.
    Promise.resolve()
      .then(() => opts.onQueued!(ahead))
      .catch(() => { /* swallow */ })
  }

  depths.set(key, ahead + 1)
  // Chain on settle (success OR failure) so a predecessor throwing doesn't
  // reject every waiter behind it.
  const next = prev.then(fn, fn)
  queues.set(key, next)
  try {
    return await next
  } finally {
    const d = depths.get(key) ?? 1
    if (d <= 1) depths.delete(key)
    else depths.set(key, d - 1)
    // Only clear if we're still the tail. Another caller may have queued
    // behind us in the meantime — don't drop their reference.
    if (queues.get(key) === next) {
      queues.delete(key)
    }
  }
}

/** Current queue depth for a key. 0 when nothing in flight or waiting. */
export function getQueueDepth(key: string): number {
  return depths.get(key) ?? 0
}

/** Reset all queues. Test-only. */
export function _resetThreadQueues(): void {
  queues.clear()
  depths.clear()
}
