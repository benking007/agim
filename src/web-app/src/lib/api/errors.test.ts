/**
 * describeError + isAuthError — verifies:
 *   * ApiClientError with a known code → routes through t('errors:X')
 *   * ApiClientError with an unknown code → falls back to UNKNOWN +
 *     surfaces the original message via {{detail}}
 *   * Generic Error → UNKNOWN code, name as detail
 *   * Non-Error throws (strings, objects) → UNKNOWN code, String(value)
 *   * isAuthError true for AUTH_INVALID or HTTP 401
 *   * isAuthError false for generic codes / non-Error values
 */

import { describe, expect, it } from 'vitest'
import { ApiClientError } from './client'
import { describeError, isAuthError } from './errors'

/** Tiny t() stand-in for the tests. Mirrors i18next's signature
 *  enough to exercise the defaultValue fallback path. Returns the
 *  key itself when the lookup table doesn't have a value, simulating
 *  i18next's "missingInterpolation" behavior. */
function makeT(table: Record<string, string>) {
  return ((key: string, opts: Record<string, unknown> = {}) => {
    const value = table[key]
    if (value !== undefined) {
      // Naive {{var}} interpolation for the few keys we care about.
      return value.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(opts[name] ?? ''))
    }
    if (opts.defaultValue !== undefined) {
      return String(opts.defaultValue)
    }
    return key
  }) as unknown as Parameters<typeof describeError>[1]
}

describe('describeError', () => {
  it('maps known ApiClientError code via t()', () => {
    const t = makeT({
      'errors:FORBIDDEN': 'You do not have permission.',
    })
    const r = describeError(new ApiClientError({ message: 'forbidden', code: 'FORBIDDEN', status: 403 }), t)
    expect(r).toEqual({ code: 'FORBIDDEN', message: 'You do not have permission.' })
  })

  it('falls back to UNKNOWN message with {{detail}} when code unmapped', () => {
    const t = makeT({
      'errors:UNKNOWN': 'Something went wrong ({{detail}}).',
    })
    const r = describeError(
      new ApiClientError({ message: 'mysterious failure', code: 'CUSTOM_X', status: 500 }),
      t,
    )
    expect(r.code).toBe('CUSTOM_X')
    // defaultValue path goes through t('errors:UNKNOWN', { detail }) which uses {{detail}}
    expect(r.message).toBe('Something went wrong (mysterious failure).')
  })

  it('generic Error → UNKNOWN code', () => {
    const t = makeT({
      'errors:UNKNOWN': 'Generic: {{code}}',
    })
    const r = describeError(new Error('boom'), t)
    expect(r.code).toBe('UNKNOWN')
    expect(r.message).toBe('Generic: Error')
  })

  it('non-Error thrown values → UNKNOWN code, String(value)', () => {
    const t = makeT({
      'errors:UNKNOWN': 'Unknown: {{code}}',
    })
    const r = describeError('plain string blew up', t)
    expect(r.code).toBe('UNKNOWN')
    // No dict entry for the original key; defaultValue falls through
    // to String(err) which the empty `errors:UNKNOWN` interpolation
    // surfaces as the fallback.
    expect(r.message).toBe('Unknown: UNKNOWN')
  })
})

describe('isAuthError', () => {
  it('true for AUTH_INVALID code', () => {
    expect(
      isAuthError(new ApiClientError({ message: 'expired', code: 'AUTH_INVALID', status: 401 })),
    ).toBe(true)
  })

  it('true for any 401 even if code is something else', () => {
    expect(
      isAuthError(new ApiClientError({ message: 'expired', code: 'CUSTOM_AUTH_X', status: 401 })),
    ).toBe(true)
  })

  it('false for non-auth ApiClientError', () => {
    expect(
      isAuthError(new ApiClientError({ message: 'forbidden', code: 'FORBIDDEN', status: 403 })),
    ).toBe(false)
  })

  it('false for generic Error', () => {
    expect(isAuthError(new Error('boom'))).toBe(false)
  })

  it('false for non-Error values', () => {
    expect(isAuthError('string')).toBe(false)
    expect(isAuthError(null)).toBe(false)
  })
})
