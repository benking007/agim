// Constant-time string compare for auth-token comparison.
// Returns false when lengths differ, otherwise defers to crypto.timingSafeEqual.

import { timingSafeEqual } from 'crypto'

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}
