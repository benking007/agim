// R9 — server-side mask helper round-trip. The pre-R9 isMasked regex
// allowed ≤2 chars of padding either side of the asterisks, but
// maskSecret produces 4 chars of padding for any input >8 chars. That
// mismatch meant an echoed mask from a buggy / malicious client could
// overwrite the real IMHUB_SMTP_PASS / Baidu AK / OpenAI key with
// literal asterisks (lockout, not exfil — but still a footgun).
//
// These tests assert maskSecret(any) → isMasked() === true so the two
// functions can never drift out of sync again.

import { describe, it, expect } from 'bun:test'
import { isMasked, maskSecret } from '../../src/web/env-mask'

describe('maskSecret', () => {
  it('returns empty for empty input', () => {
    expect(maskSecret('')).toBe('')
  })

  it('returns all-asterisks for inputs ≤ 8 chars', () => {
    expect(maskSecret('a')).toBe('*')
    expect(maskSecret('hello')).toBe('*****')
    expect(maskSecret('eightch!')).toBe('********')
  })

  it('returns all-asterisks for 9–10 char inputs too (need ≥3 middle stars to be unambiguous)', () => {
    expect(maskSecret('nineCharP')).toBe('*********')
    expect(maskSecret('tenCharsHI')).toBe('**********')
  })

  it('shows first-4 + asterisks + last-4 for inputs > 10 chars', () => {
    expect(maskSecret('elevenCharS')).toBe('elev' + '***' + 'harS')
    expect(maskSecret('the-quick-brown-fox')).toBe('the-***********-fox')
    expect(maskSecret('x'.repeat(32))).toBe('xxxx' + '*'.repeat(24) + 'xxxx')
  })
})

describe('isMasked', () => {
  it.each([
    [''],
    ['plain'],
    ['hello world'],
    ['abc-1234'],
    // Real secrets that happen to contain triple-star are NOT masked
    // (no padding constraint would let this slip past 9 chars):
    ['my***pwd***value'], // 3 chars between, then 6 trailing → 6 non-asterisk on the right side, fails the {0,4} guard
  ])('refuses %j', (v) => {
    expect(isMasked(v)).toBe(false)
  })

  it.each([
    ['*'],
    ['****'],
    ['********'],          // pure-asterisks mask for ≤8 char secret
    ['ab****yz'],          // canonical form
    ['abcd***wxyz'],
    ['abcd' + '*'.repeat(24) + 'wxyz'],
  ])('accepts %j', (v) => {
    expect(isMasked(v)).toBe(true)
  })
})

describe('maskSecret + isMasked round-trip (the regression this guards)', () => {
  it.each([
    ['1'],
    ['short'],
    ['eightch!'],
    ['nineCharP'],
    ['a-real-32-char-ish-baidu-map-aktoken'],
    ['sk-proj-1234567890abcdefghij'],
    ['x'.repeat(100)],
  ])('round-trips %j', (secret) => {
    expect(isMasked(maskSecret(secret))).toBe(true)
  })
})
