/**
 * lib/api/errors.ts — single place mapping ApiClientError to a user-
 * facing toast string. PR-3 introduced ApiClientError with a `code`
 * field; this file is the consumer side.
 *
 * Why a separate module instead of inlining in QueryClient.onError:
 *   - Multiple places need to resolve the same message (toast,
 *     error boundary, form-error inline). One translator keeps them
 *     in sync.
 *   - Tests can assert "code X → key Y" without rendering React.
 */

import type { TFunction } from 'i18next'
import { ApiClientError } from './client'

/**
 * Translate any thrown value (ApiClientError, generic Error, anything)
 * into a stable error code + a human-readable message. The i18n
 * dictionary in `errors` namespace is the source of truth — see
 * src/i18n/locales/{en,zh}/errors.json.
 */
export function describeError(err: unknown, t: TFunction): { code: string; message: string } {
  if (err instanceof ApiClientError) {
    // The fallback path also gets `detail` so `errors:UNKNOWN` can
    // interpolate the raw backend message. Without this the
    // "Something went wrong ({{detail}})." template fell through
    // empty when the per-code key didn't exist in the dict.
    const fallback = t('errors:UNKNOWN', {
      code: err.code,
      detail: err.message,
      defaultValue: err.message,
    })
    const message = t(`errors:${err.code}`, {
      defaultValue: fallback,
      detail: err.message,
    })
    return { code: err.code, message }
  }
  if (err instanceof Error) {
    return {
      code: 'UNKNOWN',
      message: t('errors:UNKNOWN', { code: err.name, defaultValue: err.message }),
    }
  }
  return {
    code: 'UNKNOWN',
    message: t('errors:UNKNOWN', { code: 'UNKNOWN', defaultValue: String(err) }),
  }
}

/**
 * isAuthError — true when the error indicates the user must re-auth.
 * Used by useAuth + the QueryClient to trigger the /login redirect.
 */
export function isAuthError(err: unknown): boolean {
  return err instanceof ApiClientError
    && (err.code === 'AUTH_INVALID' || err.code === 'AUTH_ADMIN_REQUIRED' || err.status === 401)
}
