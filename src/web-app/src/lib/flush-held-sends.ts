/**
 * Auto-flush "send after this turn" only on a real busy → idle edge.
 * Mount / HISTORY hydration starts idle and must not fire a new `message`
 * that would abort the still-running server job.
 */
export function shouldFlushHeldSends(opts: {
  wasBusy: boolean
  isBusy: boolean
  historyLoading?: boolean
}): boolean {
  if (opts.historyLoading) return false
  return opts.wasBusy && !opts.isBusy
}
