/** Race `promise` against a timer. The timer is always cleared and unref'd. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out (${ms}ms)`)), ms)
        if (timer && typeof timer === 'object' && 'unref' in timer) {
          timer.unref()
        }
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
