/**
 * Secret-masking helpers for the web env editor (GET/PUT /api/env).
 *
 * `maskSecret` produces the wire form returned in the masked GET:
 *   * empty → ''
 *   * ≤ 8 chars → repeated '*' of same length (so length is preserved
 *     for UI sizing but no info leaks)
 *   * > 8 chars → first 4 + asterisks + last 4 (operator can recognise
 *     "is this my prod key" without copy-pasting the secret)
 *
 * `isMasked` is the inverse check used on PUT to drop "client echoed
 * the mask back" updates so a real value isn't overwritten with
 * literal asterisks. The two functions MUST stay in sync — extracted
 * here as a module so the bun unit suite can assert that property
 * directly (see test/unit/env-mask.test.ts).
 *
 * Both functions are pure / dependency-free.
 */

export function maskSecret(v: string): string {
  if (!v) return ''
  // Threshold bumped from 8 → 10 (R9): below 11 chars there's no room
  // for the 4+N+4 form to leave ≥3 asterisks in the middle, which is
  // what isMasked uses to distinguish "this is a mask" from "this just
  // happens to contain an asterisk." For 9-10 char secrets we now show
  // pure asterisks instead.
  if (v.length <= 10) return '*'.repeat(v.length)
  return v.slice(0, 4) + '*'.repeat(v.length - 8) + v.slice(-4)
}

export function isMasked(value: string | undefined): boolean {
  if (!value) return false
  // Two valid mask shapes from maskSecret() above:
  //   * pure asterisks (≤8 chars)
  //   * `<≤4 chars>****<≤4 chars>` (>8 chars; padding is 4 chars on
  //     each side, but we allow 0..4 to keep the regex tolerant of
  //     hand-typed masks in tests / cli probes)
  // The non-padding chars must NOT themselves be asterisks, otherwise
  // a real secret like `***foo***` would be considered masked and
  // silently dropped on PUT.
  return /^\*+$/.test(value) || /^[^*]{0,4}\*{3,}[^*]{0,4}$/.test(value)
}
