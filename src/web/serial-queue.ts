// serial-queue — lightweight FIFO async queue for WebSocket inbound frames.
// Prevents concurrent handling of chat messages from the same connection
// while allowing bypass frames (approval-action, stop, steer) to run immediately.

export function createSerialQueue(): (fn: () => Promise<void>) => void {
  let queue: Promise<void> = Promise.resolve()
  return (fn: () => Promise<void>): void => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    void run
  }
}
