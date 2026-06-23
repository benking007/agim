// Smooth streaming reveal helpers for the TUI. Agent backends emit coarse
// chunks (whole text blocks / parts / final message), which makes the chat
// feel like it lands "一段一段". We decouple display cadence from chunk
// arrival by revealing the accumulated text a few characters per frame.
//
// Pure + dependency-free so it can be unit-tested without an ink runtime.

/** Next revealed length, easing toward `target`. Advances by a proportional
 *  step (so big gaps catch up fast, small gaps stay smooth) with a floor so
 *  it never stalls. Never overshoots and never moves backward. */
export function nextRevealLen(
  current: number, target: number, opts?: { minStep?: number; div?: number },
): number {
  if (current >= target) return current
  const minStep = opts?.minStep ?? 2
  const div = opts?.div ?? 6
  const step = Math.max(minStep, Math.ceil((target - current) / div))
  return Math.min(target, current + step)
}

/** Frame interval in ms. Override cadence via IMHUB_TUI_STREAM_FPS. */
export function resolveTickMs(): number {
  const fps = Number(process.env.IMHUB_TUI_STREAM_FPS)
  return Number.isFinite(fps) && fps > 0 ? Math.max(10, Math.round(1000 / fps)) : 40
}

/** Whether smooth reveal is on. Set IMHUB_TUI_STREAM_SMOOTH=0 to render each
 *  chunk immediately (the pre-v1.3.8 behavior). */
export function streamSmoothingEnabled(): boolean {
  return process.env.IMHUB_TUI_STREAM_SMOOTH !== '0'
}
